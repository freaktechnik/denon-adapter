// Copyright (c) 2021 Martin Giger
// 
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

'use strict';

const { Adapter, Device, Property, Event, Database, Action } = require('gateway-addon');
const manifest = require('./manifest.json');
const heos = require('heos-api');
const { DenonAVR } = require('@chaws/denon');
const { Client } = require('node-ssdp');
const fetch = require('node-fetch');
const xmlParser = require('fast-xml-parser');
const S_TO_MS = 1000;

// heos: http://rn.dmglobal.com/euheos/HEOS_CLI_ProtocolSpecification.pdf
// telnet: http://assets.denon.com/DocumentMaster/us/DENON_FY20%20AVR_PROTOCOL_V03_03042020.xlsx?Web=1
// telnet control: https://assets.denon.com/_layouts/15/xlviewer.aspx?id=/DocumentMaster/us/DENON_FY20%20AVR_PROTOCOL_V03_03042020.xlsx
// IR codes: http://assets.denon.com/DocumentMaster/us/AVR-X3600H_IR_CODE_V01_03042020.doc
//TODO offer a device per zone
//TODO make discovery faster/use IPs from AVR discovery for HEOS?

const SOURCES = {
    1: 'Pandora',
    2: 'Rhapsody',
    3: 'TuneIn',
    4: 'Spotify',
    5: 'Deezer',
    6: 'Napster',
    7: 'iHeartRadio',
    8: 'Sirius XM',
    9: 'Soundcloud',
    10: 'Tidal',
    12: 'Rdio',
    13: 'Amazon Music',
    15: 'Moodmix',
    16: 'Juke',
    18: 'QQMusic',
    1024: 'Local Music',
    1025: 'Playlist',
    1026: 'History',
    1027: 'Aux',
    1028: 'Favorites'
};

const STATION_CANT_PAUSE = [
    3,
    7,
    8,
    1027
];

const NO_SONG = [
    1,
    8,
    1028,
    1027
];

const NO_STATION = [
    10,
    1024,
    1025
];

class HEOSProperty extends Property {
    async setValue(value) {
        switch(this.name) {
            case 'playing':
                const source = await this.getProperty('source');
                const sourceId = this.adapter.sourceInfo.find((si) => si.name === source).sid;
                const pauseType = this.sourceType === 'station' && STATION_CANT_PAUSE.includes(Number.parseInt(sourceId)) ? 'stop' : 'pause';
                this.device.adapter.makeHeosRequest('player', 'set_play_state', {
                    pid: this.device.heosPlayer.pid,
                    state: value ? 'play' : pauseType
                });
                break;
            case 'volume':
                this.device.adapter.makeHeosRequest('player', 'set_volume', {
                    pid: this.device.heosPlayer.pid,
                    level: Math.floor(value).toString(10) //TODO can we send a float here?
                });
                break;
            case 'muted':
                this.device.adapter.makeHeosRequest('player', 'set_muted', {
                    pid: this.device.heosPlayer.pid,
                    state: value ? 'on' : 'off'
                });
                break;
            case 'repeat':
                const shuffle = await this.device.getProperty('shuffle');
                this.device.adapter.makeHeosRequest('player', 'set_play_mode', {
                    pid: this.device.heosPlayer.pid,
                    repeat: value,
                    shuffle: shuffle ? 'on' : 'off'
                });
                break;
            case 'shuffle':
                const repeat = await this.device.getProperty('repeat');
                this.device.adapter.makeHeosRequest('player', 'set_play_mode', {
                    pid: this.device.heosPlayer.pid,
                    repeat,
                    shuffle: value ? 'on' : 'off'
                });
                break;
        }
    }
}

class HEOSDevice extends Device {
    /**
     * @param {Adapter} adapter
     * @param {object} player
     */
    constructor(adapter, info) {
        const { player } = info;
        super(adapter, `heos-${player.pid}`);
        this.name = player.name;
        this.setDescription(player.model);
        this.heosPlayer = player;
        for(const [key, value] of Object.entries(info)) {
            if(key !== 'player') {
                this[key] = value;
            }
        }
        /**
         * @type {'song'|'station'|null}
         */
        this.sourceType = null;
        this.availablePlaybackOptions = [];
        this.ready = Promise.resolve();
        this.buildSchema();
        this.updateState();

        this.ready.then(() => this.adapter.handleDeviceAdded(this));
        //TODO handle actions
    }

    buildSchema() {
        this.addProperty(new HEOSProperty(this, 'playing', {
            title: 'Playing',
            type: 'boolean'
        }));
        //TODO in theory no volume control if lineout type is fixed, but docs make no sense
        this.addProperty(new HEOSProperty(this, 'volume', {
            title: 'Volume',
            type: 'number',
            minimum: 0,
            maximum: 100,
            multipleOf: 1,
            '@type': 'LevelProperty'
        }));
        this.addProperty(new HEOSProperty(this, 'muted', {
            title: 'Muted',
            type: 'boolean'
        }));
        this.addProperty(new HEOSProperty(this, 'repeat', {
            title: 'Repeat',
            type: 'string',
            enum: [
                'off',
                'on_one',
                'on_all'
            ]
        }));
        this.addProperty(new HEOSProperty(this, 'shuffle', {
            title: 'Shuffle',
            type: 'boolean'
        }));
        this.addAction('next', {
            title: 'Next'
        });
        this.addAction('previous', {
            title: 'Previous'
        });
        this.addAction('toggleMute', {
            title: 'Toggle Mute'
        });
        this.addAction('stop', {
            title: 'Stop'
        });

        this.addProperty(new HEOSProperty(this, 'title', {
            title: 'Title',
            type: 'string',
            readOnly: true
        }));
        this.addProperty(new HEOSProperty(this, 'artist', {
            title: 'Artist',
            type: 'string',
            readOnly: true
        }));
        this.addProperty(new HEOSProperty(this, 'album', {
            title: 'Album',
            type: 'string',
            readOnly: true
        }));
        this.addProperty(new HEOSProperty(this, 'station', {
            title: 'Station',
            type: 'string',
            readOnly: true
        }));
        this.addProperty(new HEOSProperty(this, 'albumArt', {
            title: 'Album Art',
            type: 'null',
            links: [
                {
                    mediaType: 'image/png',
                    href: '',
                    rel: 'alternate'
                }
            ],
            readOnly: true
        }));
        this.addProperty(new HEOSProperty(this, 'source', {
            title: 'source',
            type: 'string',
            enum: this.adapter.sourceInfo.map((source) => source.name),
            readOnly: true
        }));

        this.addAction('play', {
            title: 'Play URL',
            description: 'Play file from an URL',
            input: {
                type: 'string'
            }
        });
        this.addAction('playPreset', {
            title: 'Play Preset Station',
            input: {
                type: 'integer',
                minimum: 1,
                maximum: 100
            }
        });
        this.addAction('playInput', {
            title: 'Play Input',
            input: {
                type: 'string',
                enum: [
                    'inputs/aux_in_1',
                    'inputs/aux_in_2',
                    'inputs/aux_in_3',
                    'inputs/aux_in_4',
                    'inputs/aux_single',
                    'inputs/aux1',
                    'inputs/aux2',
                    'inputs/aux3',
                    'inputs/aux4',
                    'inputs/aux5',
                    'inputs/aux6',
                    'inputs/aux7',
                    'inputs/line_in_1',
                    'inputs/line_in_2',
                    'inputs/line_in_3',
                    'inputs/line_in_4',
                    'inputs/coax_in_1',
                    'inputs/coax_in_2',
                    'inputs/optical_in_1',
                    'inputs/optical_in_2',
                    'inputs/hdmi_in_1',
                    'inputs/hdmi_in_2',
                    'inputs/hdmi_in_3',
                    'inputs/hdmi_in_4',
                    'inputs/hdmi_arc_1',
                    'inputs/cable_sat',
                    'inputs/dvd',
                    'inputs/bluray',
                    'inputs/game',
                    'inputs/mediaplayer',
                    'inputs/cd',
                    'inputs/tuner',
                    'inputs/hdradio',
                    'inputs/tvaudio',
                    'inputs/phono',
                    'inputs/usbdac',
                    'inputs/analog'
                ]
            }
        });

        //TODO duration & position properties

        //TODO action to add currently playing media to favorites
        //TODO action thumbs up
        //TODO action thumbs down

        //TODO group controls
        //TODO queue controls
        //TODO browse stuff?

        // Only available on connected device -> so only for local network devices
        // this.addAction('reboot', {
        //     title: 'Reboot'
        // });

        this.addEvent('playbackError', {
            title: 'Playback Errro',
            type: 'string'
        });
        this.addEvent('progress', {
            title: 'Progress',
            type: 'number',
            minimum: 0,
            unit: 'ms'
        });
    }

    async updateState() {
        await this.adapter.ensureHeosConnection();
        //TODO re-add listener when heosConnection resumes
        this.adapter.heosConnection.onAll((message) => {
            if (message.heos?.message?.parsed?.pid == this.heosPlayer.pid && (message.heos?.result ?? 'success') === 'success') {
                try {
                    this.handleHeosEvent(message);
                }
                catch(error) {
                    console.error(error);
                }
            }
        });
        this.adapter.heosConnection.write('system', 'register_for_change_events', {
            enable: 'on'
        });
        this.adapter.heosConnection.write('player', 'get_play_state', {
            pid: this.heosPlayer.pid
        });
        this.adapter.heosConnection.write('player', 'get_volume', {
            pid: this.heosPlayer.pid
        });
        this.adapter.heosConnection.write('player', 'get_mute', {
            pid: this.heosPlayer.pid
        });
        this.adapter.heosConnection.write('player', 'get_play_mode', {
            pid: this.heosPlayer.pid
        });
        this.adapter.heosConnection.write('player', 'get_now_playing_media', {
            pid: this.heosPlayer.pid
        });
    }

    handleHeosEvent(message) {
        console.log(message.heos.command.commandGroup, message.heos.command.command, message.heos.message.parsed, message.payload);
        const payload = message.heos.message.parsed;
        switch(`${message.heos.command.commandGroup}/${message.heos.command.command}`) {
            case 'player/get_play_state':
            case 'event/player_state_changed':
                this.findProperty('playing').setCachedValueAndNotify(payload.state === 'play');
                if(payload.state === 'stop') {
                    this.sourceType = null;
                    this.availablePlaybackOptions = [];
                }
                break;
            case 'player/get_now_playing_media':
            case 'event/player_now_playing_changed':
                if (!message.payload) {
                    //TOOD make request
                    break;
                }
                const sourceName = this.adapter.sourceInfo.find((source) => source.sid == message.payload.sid).name;
                this.findProperty('source').setCachedValueAndNotify(sourceName);
                this.findProperty('title').setCachedValueAndNotify(message.payload.song);
                this.findProperty('album').setCachedValueAndNotify(message.payload.album);
                this.findProperty('artist').setCachedValueAndNotify(message.payload.artist);
                // this.findProperty('albumArt').links[0].href = message.payload.image_url;
                this.findProperty('station').setCachedValueAndNotify(message.payload?.station);
                this.sourceType = message.payload.type;
                this.availablePlaybackOptions = message.options;
                break;
            case 'player/get_volume':
            case 'event/player_volume_changed':
                this.findProperty('volume').setCachedValueAndNotify(Number.parseFloat(payload.level));
                if(message.heos.command.commandGroup === 'events') {
                    this.findProperty('muted').setCachedValueAndNotify(payload.mute === 'on');
                }
                break;
            case 'player/get_mute':
                this.findProperty('muted').setCachedValueAndNotify(payload.state === 'on');
                break;
            case 'player/get_play_mode':
                this.findProperty('repeat').setCachedValueAndNotify(payload.repeat);
                this.findProperty('shuffle').setCachedValueAndNotify(payload.shuffle === 'on');
                break;
            case 'event/repeat_mode_changed':
                this.findProperty('repeat').setCachedValueAndNotify(payload.repeat);
                break;
            case 'event/shuffle_mode_changed':
                this.findProperty('shuffle').setCachedValueAndNotify(payload.shuffle === 'on');
                break;
            case 'event/player_now_playing_progress':
                this.eventNotify(new Event(this, 'progress', Number.parseInt(payload.cur_pos)));
                break;
            case 'event/player_playback_error':
                this.eventNotify(new Event(this, 'playbackError', payload.error));
                break;
        }
    }

    /**
     *
     * @param {Action} action
     */
    async performAction(action) {
        switch(action.getName()) {
            case 'next':
                await this.adapter.makeHeosRequest('player', 'play_next', {
                    pid: this.heosPlayer.pid
                });
                break;
            case 'previous':
                await this.adapter.makeHeosRequest('player', 'play_previous', {
                    pid: this.heosPlayer.pid
                });
                break;
            case 'toggleMute':
                await this.adapter.makeHeosRequest('player', 'toggle_mute', {
                    pid: this.heosPlayer.pid
                });
                break;
            case 'stop':
                await this.adapter.makeHeosRequest('player', 'set_play_state', {
                    pid: this.heosPlayer.pid,
                    state: 'stop'
                });
                break;
            case 'play':
                await this.adapter.makeHeosRequest('browse', 'play_stream', {
                    pid: this.heosPlayer.pid,
                    url: action.getInput()
                });
                break;
            case 'playPreset':
                await this.adapter.makeHeosRequest('browse', 'play_preset', {
                    pid: this.heosPlayer.pid,
                    preset: action.getInput()
                });
                break;
            case 'playInput':
                await this.adapter.makeHeosRequest('browse', 'play_input', {
                    pid: this.heosPlayer.pid,
                    input: action.getInput()
                });
                break;
        }
    }

    destroy() {
        //TODO remove heosConnection.onAll listener
    }
}

const IR_MAP = {
    status: 'RCSHP0230030',
    btPair: 'RCKSK0410751',
};

class DenonProperty extends Property {
    async setValue(value) {
        switch(this.name) {
            case 'on':
                await this.device.denonDevice.connection.exec(value ? 'PWON' : 'PWSTANDBY');
                break;
            case 'audysseyLFC':
                await this.device.denonDevice.connection.exec(`PSLFC ${value ? 'ON' : 'OFF'}`);
                break;
            case 'band':
                await this.device.denonDevice.connection.exec(`TMAN${value}`);
                break;
            case 'preset':
                await this.device.denonDevice.connection.exec(`TPAN${value.toFixed(0).padStart(2, '0')}`);
                break;
            case 'tunerFrequency':
                await this.device.denonDevice.connection.exec(`TFAN${(value * 100).toFixed(0).padStart(6, '0')}`);
                break;
        }
    }
}

class DenonDevice extends HEOSDevice {
    buildSchema() {
        super.buildSchema();

        this.denonDevice = new DenonAVR({ host: this.avr.address });
        this.denonDevice.on('disconnected', () => {
            this.connectedNotify(false);
        });
        this.denonDevice.on('connected', () => {
            this.connectedNotify(true);
        });
        this.ready = this.denonDevice.connect();

        this.addProperty(new DenonProperty(this, 'on', {
            title: 'Power',
            type: 'boolean',
            '@type': 'OnOffProperty'
        }));
        //TODO merge better direct control with heos properties
        //TODO override volume property?
        //TODO allow setting source/input
        //TODO granular volume properties
        // this.addProperty(new DenonProperty(this, 'input', {
        //     title: 'Input',
        //     type: 'string',
        //     enum: [
        //         'PHONO',
        //         'CD',
        //         'DVD',
        //         'BD',
        //         'TV',
        //         'SAT/CBL',
        //         'MPLAY',
        //         'GAME',
        //         'TUNER',
        //         'AUX1',
        //         'AUX2',
        //         'NET', // HEOS
        //         'BT'
        //     ],
        // }));
        // this.addProperty(new HEOSProperty(this, 'audioInput', {
        //     title: 'Audio Input',
        //     type: 'string',
        //     enum: [],
        // }));
        // this.addProperty(new DenonProperty(this, 'videoInput', {
        //     title: 'Video Input',
        //     type: 'string',
        //     enum: [
        //         'DVD',
        //         'BD',
        //         'TV',
        //         'SAT/CBL',
        //         'MPLAY',
        //         'GAME',
        //         'AUX1',
        //         'AUX2',
        //         'CD',
        //         'ON',
        //         'OFF'
        //     ]
        // }));
        // this.addProperty(new DenonProperty(this, 'videoOutput', {
        //     title: 'Video Output',
        //     type: 'string',
        //     enum: [
        //         'AUTO',
        //         '1', //HDMI1
        //         '2' //HDMI2
        //     ]
        // }));

        // this.addProperty(new HEOSProperty(this, 'surroundMode', {
        //     title: 'Surround Mode',
        //     type: 'string',
        //     enum: [
        //         'MOVIE',
        //         'MUSIC',
        //         'GAME',
        //         'DIRECT',
        //         'PURE DIRECT',
        //         'STEREO',
        //         'AUTO',
        //         'DOLBY DIGITAL',
        //         'DTS SURROUND',
        //         'MCH STEREO',
        //         'ROCK ARENA',
        //         'JAZZ CLUB',
        //         'MONO MOVIE',
        //         'MATRIX',
        //         'VIDEO GAME',
        //         'VIRTUAL'
        //     ]
        // }));
        // this.addProperty(new HEOSProperty(this, 'subwoofer', {
        //     title: 'Subwoofer',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'toneControl', {
        //     title: 'Tone Control',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'bass', {
        //     title: 'Bass',
        //     type: 'number',
        //     minimum: 0,
        //     maximum: 100,
        //     '@type': 'LevelProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'treble', {
        //     title: 'Treble',
        //     type: 'number',
        //     minimum: 0,
        //     maximum: 100,
        //     '@type': 'LevelProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'loudness', {
        //     title: 'Loudness',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'clearVoice', {
        //     title: 'Clear Voice',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'lfe', {
        //     title: 'LFE',
        //     type: 'boolean' //TODO maybe an enum for off/soft/strong or w/e
        // }));
        // this.addProperty(new HEOSProperty(this, 'headphones', {
        //     title: 'Headphones',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'dialogControl', {
        //     title: 'Dialog Control',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'neuralX', {
        //     title: 'NeuralX',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'multEQ', {
        //     title: 'MultEQ',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'dynamicEQ', {
        //     title: 'Dynamic EQ',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'dynamicVolume', {
        //     title: 'Dynamic Volume',
        //     type: 'boolean'
        // }));
        this.addProperty(new DenonProperty(this, 'audysseyLFC', {
            title: 'Audyssey LFC',
            type: 'boolean'
        }));
        // this.addProperty(new HEOSProperty(this, 'graphicEQ', {
        //     title: 'Graphic EQ',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'drc', {
        //     title: 'DRC',
        //     type: 'boolean'
        // }));

        // this.addProperty(new DenonProperty(this, 'aspectRatio', {
        //     title: 'Aspect Ratio',
        //     type: 'string',
        //     enum: [
        //         '16:9',
        //         '4:3'
        //     ]
        // }));
        // this.addProperty(new DenonProperty(this, 'videoResolution', {
        //     title: 'Video Resolution',
        //     type: 'string',
        //     enum: [
        //         '48P', // 480p
        //         '10I', // 1080i
        //         '72P', // 720p
        //         '10P',
        //         '10P24', // 1080p24
        //         '4K',
        //         '4KF', // 4K60
        //         'AUTO'
        //     ]
        // }));
        // this.addProperty(new HEOSProperty(this, 'videoProcessingMode', {
        //     title: 'Video Processing Mode',
        //     type: 'string',
        //     enum: []
        // }));
        // this.addProperty(new DenonProperty(this, 'videoMode', {
        //     title: 'Picture Mode',
        //     type: 'string',
        //     enum: [
        //         'AUTO',
        //         'GAME',
        //         'MOVI', // movie
        //         'BYP' // bypass
        //     ]
        // })); //picture mode
        // this.addProperty(new HEOSProperty(this, 'imax', {
        //     title: 'IMAX',
        //     type: 'string',
        //     enum: []
        // }));
        // this.addProperty(new HEOSProperty(this, 'cinemaEQ', {
        //     title: 'Cinema EQ',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'contrast', {
        //     title: 'Contrast',
        //     type: 'number',
        //     '@type': 'LevelProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'brightness', {
        //     title: 'Brightness',
        //     type: 'number',
        //     '@type': 'LevelProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'saturation', {
        //     title: 'Saturation',
        //     type: 'number',
        //     '@type': 'LevelProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'dnr', {
        //     title: 'DNR',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'enhancer', {
        //     title: 'Enhancer',
        //     type: 'boolean'
        // }));

        // this.addProperty(new HEOSProperty(this, 'autoStandby', {
        //     title: 'Auto Standby',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'eco', {
        //     title: 'Eco',
        //     type: 'boolean'
        // }));
        // this.addProperty(new HEOSProperty(this, 'sleep', {
        //     title: 'Sleep',
        //     type: 'boolean'
        // }));

        this.addAction('up', {
            title: 'Up'
        });
        this.addAction('down', {
            title: 'Down'
        });
        this.addAction('left', {
            title: 'Left'
        });
        this.addAction('right', {
            title: 'Right'
        });
        this.addAction('enter', {
            title: 'Enter'
        });
        this.addAction('options', {
            title: 'Options'
        });
        this.addAction('info', {
            title: 'Info'
        });
        this.addAction('back', {
            title: 'Back'
        });
        this.addAction('btPair', {
            title: 'Bluetooth Pairing'
        });
        // this.addAction('quickSelect', {
        //     title: 'Quick Select',
        //     input: {
        //         type: 'integer',
        //         minimum: 1,
        //         maximum: 5
        //     }
        // });

        this.addAction('seekUp', {
            title: 'Seek Up'
        });
        this.addAction('seekDown', {
            title: 'Seek Down'
        });
        this.addProperty(new DenonProperty(this, 'tunerFrequency', {
            title: 'Frequency',
            type: 'number',
            unit: 'MHz',
            multipleOf: 0.01,
            minimum: 80
        }));
        // this.addAction('channelUp', {
        //     title: 'Channel Up'
        // });
        // this.addAction('channelDown', {
        //     title: 'Channel Down'
        // });
        this.addProperty(new DenonProperty(this, 'preset', {
            title: 'Preset',
            type: 'integer',
            minimum: 1,
            maximum: 56
        }));
        this.addProperty(new DenonProperty(this, 'band', {
            title: 'band',
            type: 'string',
            enum: [
                'AM',
                'FM'
            ]
        }));

        //TODO separate thing?
        // this.addProperty(new HEOSProperty(this, 'zone2On', {
        //     title: 'Zone 2 Power',
        //     type: 'boolean',
        //     '@type': 'OnOffProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'zone2Input', {
        //     title: 'Zone 2 Input',
        //     type: 'string',
        //     enum: []
        // }));
        // this.addProperty(new HEOSProperty(this, 'zone2Volume', {
        //     title: 'Zone 2 Volume',
        //     type: 'number',
        //     minimum: 0,
        //     maximum: 100,
        //     '@type': 'LevelProperty'
        // }));
        // this.addProperty(new HEOSProperty(this, 'zone2Mute', {
        //     title: 'Zone 2 Muted',
        //     type: 'boolean'
        // }));
    }

    async updateState() {
        await Promise.all([
            super.updateState(),
            this.ready
        ]);
        //TODO maybe use main zone info?
        this.denonDevice.on('powerOn', () => {
            this.findProperty('on').setCachedValueAndNotify(true);
        });
        this.denonDevice.on('powerStandby', () => {
            this.findProperty('on').setCachedValueAndNotify(false);
        });
        const decoder = new TextDecoder();
        this.denonDevice.on('raw', (buffer) => {
            this.handleDenonInfo(decoder.decode(buffer));
        });
        await this.denonDevice.connection.exec('PW?');
        // initialize properties on first power on
        this.denonDevice.once('powerOn', async () => {
            await this.denonDevice.connection.exec('PSLFC?');
            await this.denonDevice.connection.exec('TFAN?');
            await this.denonDevice.connection.exec('TPAN?');
            await this.denonDevice.connection.exec('TMAN?');
        });
    }

    handleDenonInfo(message) {
        if(message.startsWith('PSLFC')) {
            this.findProperty('audysseyLFC').setCachedValueAndNotify(message.endsWith(' ON'));
        }
        else if(message.startsWith('TFAN')) {
            this.findProperty('tunerFrequency').setCachedValueAndNotify(Number.parseInt(message.slice(4) / 100));
        }
        else if(message.startsWith('TMAN') && message.length === 6) {
            this.findProperty('band').setCachedValueAndNotify(message.slice(4));
        }
        else if(message.startsWith('TPAN')) {
            const presetNumber = Number.parseInt(message.slice(4));
            if(!Number.isNaN(presetNumber)) {
                this.findProperty('preset').setCachedValueAndNotify(presetNumber);
            }
        }
        else if(message.startsWith('TFANNAME')) {
            const name = message.slice(8).trim();
            if(message.length) {
                this.findProperty('station').setCachedValueAndNotify(message);
            }
            //TODO clear if tuner is active
        }
        //TODO override station name with RDS if tuner is active
        else if(!message.startsWith('PW')) {
            console.log(message);
        }
    }

    /**
     *
     * @param {Action} action
     */
    async performAction(action) {
        if(IR_MAP.hasOwnProperty(action.getName())) {
            return this.denonDevice.connection.exec(IR_MAP[action.getName()]);
        }
        switch(action.getName()) {
            case 'up':
                await this.denonDevice.connection.exec('MNCUP');
                break;
            case 'down':
                await this.denonDevice.connection.exec('MNCDN');
                break;
            case 'left':
                await this.denonDevice.connection.exec('MNCLT');
                break;
            case 'right':
                await this.denonDevice.connection.exec('MNCRT');
                break;
            case 'enter':
                await this.denonDevice.connection.exec('MNENT');
                break;
            case 'back':
                await this.denonDevice.connection.exec('MNRTN');
                break;
            case 'options':
                await this.denonDevice.connection.exec('MNOPT');
                break;
            case 'info':
                await this.denonDevice.connection.exec('MNINF');
                break;
            case 'seekUp':
                await this.denonDevice.connection.exec('TFANUP');
                break;
            case 'seekUp':
                await this.denonDevice.connection.exec('TFANDOWN');
                break;
            default:
                return super.performAction(action);
        }
    }

    destroy() {
        super.destroy();
        this.denonDevice.disconnect();
    }
}

class DenonAdapter extends Adapter {
    constructor(addonManager) {
        super(addonManager, manifest.id, manifest.id);
        addonManager.addAdapter(this);
        /**
         * @type {HeosConnection}
         */
        this.heosConnection = null;
        this.sourceInfo = [];

        //TODO allow setting heos account to sign in with

        this.startPairing();
    }

    /**
     *
     * @returns {Promise<HeosConnection>}
     */
    async ensureHeosConnection(timeoutInS = 60) {
        if(!this.heosConnection) {
            this.heosConnection = await heos.discoverAndConnect({ timeout: timeoutInS * S_TO_MS });
            await this.initSources();
            this.heosConnection.onClose(() => {
                this.heosConnection = null;
                for(const device of Object.values(this.devices)) {
                    device.connectedNotify(false);
                }
            });
            this.heosConnection.on({ commandGroup: 'event', command: 'sources_changed' }, () => {
                this.initSources().catch(console.error);
            });
            this.heosConnection.on({ commandGroup: 'event', command: 'players_changed' }, () => {
                this._startPairing().catch(console.error);
            });
        }
        return this.heosConnection;
    }

    async initSources() {
        const message = await this.makeHeosRequest('browser', 'get_music_sources');
        this.sourceInfo = message.payload.filter((source) => source.available == 'true');
        //TODO should also update the enum on all things...
    }

    startPairing(timeoutInS = 60) {
        this._startPairing(timeoutInS).catch(console.error);
    }

    async getHeosPlayers(timeoutInS) {
        await this.ensureHeosConnection(timeoutInS);
        const message = await this.makeHeosRequest('player', 'get_players');
        return message.payload;
    }

    async getDenonAVRs(timeoutInS) {
        const client = new Client();
        const devices = [];
        client.on('response', async (meta, status, networkInfo) => {
            const request = await fetch(meta.LOCATION);
            if(request.ok && request.status == 200) {
                const xml = await request.text();
                const parsed = xmlParser.parse(xml);
                devices.push({
                    address: networkInfo.address,
                    serial: parsed.root.device.serialNumber,
                    name: parsed.root.device.friendlyName,
                    model: parsed.root.device.modelName,
                    uuid: parsed.root.device.UDN
                });
            }
        });
        client.search('urn:schemas-denon-com:device:ACT-Denon:1');
        await new Promise((resolve) => setTimeout(resolve, timeoutInS * S_TO_MS));
        client.stop();
        return devices;
    }

    async _startPairing(timeoutInS) {
        const [
            players,
            avrs
        ] = await Promise.all([
            this.getHeosPlayers(timeoutInS),
            this.getDenonAVRs(timeoutInS)
        ]);
        const seenPids = new Set();
        for(const player of players) {
            const avr = avrs.find((avr) => avr.serial === player.serial);
            this.onDiscover(player, avr);
            seenPids.add(player.pid);
        }
        for(const player of Object.values(this.devices)) {
            if(!seenPids.has(player.heosPlayer.pid)) {
                this.removeThing(player);
            }
        }
        console.log(await this.makeHeosRequest('group', 'get_groups'));
    }

    async makeHeosRequest(commandGroup, command, options) {
        await this.ensureHeosConnection();
        return new Promise((resolve, reject) => {
            this.heosConnection.once({
                commandGroup,
                command
            }, (message) => {
                if(message?.heos?.result === 'success') {
                    resolve(message);
                }
                else {
                    reject(message);
                }
            });
            this.heosConnection.write(commandGroup, command, options);
        });
    }

    onDiscover(player, avr) {
        if(!this.devices.hasOwnProperty(`heos-${player.pid}`)) {
            if(avr) {
                new DenonDevice(this, { player, avr });
            }
            else {
                new HEOSDevice(this, { player });
            }
        }
        else {
            const device = this.devices[`heos-${player.pid}`];
            device.heosPlayer = player;
            device.connectedNotify(true);
        }
    }

    handleDeviceRemoved(device) {
        device.destroy();
        super.handleDeviceRemoved(device);
    }
}

module.exports = (addonManager) => {
    new DenonAdapter(addonManager);
};
