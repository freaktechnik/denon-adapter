// Copyright (c) 2021 Martin Giger
// 
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

'use strict';

const { Adapter, Device, Property, Event, Database, Action } = require('gateway-addon');
const manifest = require('./manifest.json');
const heos = require('heos-api');
const net = require('net');
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
    async checkValue(value) {
        if(this.readOnly) {
            throw new Error('Read-only property');
        }

        if(typeof this.minimum !== 'undefined' && value < this.minimum) {
            throw new Error(`Value less than minimum: ${this.minimum}`);
        }

        if(typeof this.maximum !== 'undefined' && value > this.maximum) {
            throw new Error(`Value bigger than maximum: ${this.maximum}`);
        }

        if(this.enum && this.enum.length > 0 && !this.enum.includes(`${value}`)) {
            throw new Error('Invalid enum value');
        }
    }
    async setValue(value) {
        if(value === this.value) {
            return value;
        }
        await this.checkValue(value);
        switch(this.name) {
            case 'playing':
                const source = await this.getProperty('source');
                const sourceId = this.adapter.sourceInfo.find((si) => si.name === source).sid;
                const pauseType = this.sourceType === 'station' && STATION_CANT_PAUSE.includes(Number.parseInt(sourceId)) ? 'stop' : 'pause';
                this.device.adapter.makeHeosRequest('player', 'set_play_state', {
                    pid: this.device.heosPlayer.pid,
                    state: value ? 'play' : pauseType
                }, this);
                break;
            case 'volume':
                this.device.adapter.makeHeosRequest('player', 'set_volume', {
                    pid: this.device.heosPlayer.pid,
                    level: Math.floor(value).toString(10) //TODO can we send a float here?
                }, this);
                break;
            case 'muted':
                this.device.adapter.makeHeosRequest('player', 'set_muted', {
                    pid: this.device.heosPlayer.pid,
                    state: value ? 'on' : 'off'
                }, this);
                break;
            case 'repeat':
                const shuffle = await this.device.getProperty('shuffle');
                this.device.adapter.makeHeosRequest('player', 'set_play_mode', {
                    pid: this.device.heosPlayer.pid,
                    repeat: value,
                    shuffle: shuffle ? 'on' : 'off'
                }, this);
                break;
            case 'shuffle':
                const repeat = await this.device.getProperty('repeat');
                this.device.adapter.makeHeosRequest('player', 'set_play_mode', {
                    pid: this.device.heosPlayer.pid,
                    repeat,
                    shuffle: value ? 'on' : 'off'
                }, this);
                break;
        }
        this.setCachedValueAndNotify(value);
        return value;
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
        this.replacedProperties = [];
        this.overrideStation = false;
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
        // this.addProperty(new HEOSProperty(this, 'albumArt', {
        //     title: 'Album Art',
        //     type: 'null',
        //     links: [
        //         {
        //             mediaType: 'image/png',
        //             href: '',
        //             rel: 'alternate'
        //         }
        //     ],
        //     readOnly: true
        // }));
        this.addProperty(new HEOSProperty(this, 'source', {
            title: 'Source',
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
        if(this.hasHeosConnectionListener) {
            return;
        }
        this.hasHeosConnectionListener = true;
        this.adapter.heosConnection.onAll((message) => {
            if(this.destroyed) {
                return;
            }
            if (message && message.heos && message.heos.message && message.heos.message.parsed && message.heos.message.parsed.pid == this.heosPlayer.pid && (message.heos.result || 'success') === 'success') {
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
                const localSource = this.adapter.sourceInfo.find((source) => source.sid == message.payload.sid)
                let sourceName;
                if(!localSource) {
                    sourceName = SOURCES[message.payload.sid];
                }
                else {
                    sourceName = localSource.name;
                }

                this.findProperty('source').setCachedValueAndNotify(sourceName);
                this.findProperty('title').setCachedValueAndNotify(message.payload.song);
                this.findProperty('album').setCachedValueAndNotify(message.payload.album);
                this.findProperty('artist').setCachedValueAndNotify(message.payload.artist);
                // this.findProperty('albumArt').links[0].href = message.payload.image_url;
                if(!this.overrideStation) {
                    this.findProperty('station').setCachedValueAndNotify(message.payload.station || '');
                }
                this.sourceType = message.payload.type;
                this.availablePlaybackOptions = message.options;
                break;
            case 'player/get_volume':
            case 'event/player_volume_changed':
                if(!this.replacedProperties.includes('volume')) {
                    this.findProperty('volume').setCachedValueAndNotify(Number.parseFloat(payload.level));
                }
                if(message.heos.command.commandGroup === 'event' && !this.replacedProperties.includes('muted')) {
                    this.findProperty('muted').setCachedValueAndNotify(payload.mute === 'on');
                }
                break;
            case 'player/get_mute':
                if(this.replacedProperties.includes('muted')) {
                    break;
                }
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
        switch(action.name) {
            case 'next':
                await this.adapter.makeHeosRequest('player', 'play_next', {
                    pid: this.heosPlayer.pid
                }, this);
                break;
            case 'previous':
                await this.adapter.makeHeosRequest('player', 'play_previous', {
                    pid: this.heosPlayer.pid
                }, this);
                break;
            case 'toggleMute':
                await this.adapter.makeHeosRequest('player', 'toggle_mute', {
                    pid: this.heosPlayer.pid
                }, this);
                break;
            case 'stop':
                await this.adapter.makeHeosRequest('player', 'set_play_state', {
                    pid: this.heosPlayer.pid,
                    state: 'stop'
                }, this);
                break;
            case 'play':
                await this.adapter.makeHeosRequest('browse', 'play_stream', {
                    pid: this.heosPlayer.pid,
                    url: action.input
                }, this);
                break;
            case 'playPreset':
                await this.adapter.makeHeosRequest('browse', 'play_preset', {
                    pid: this.heosPlayer.pid,
                    preset: action.input
                }, this);
                break;
            case 'playInput':
                await this.adapter.makeHeosRequest('browse', 'play_input', {
                    pid: this.heosPlayer.pid,
                    input: action.input
                }, this);
                break;
        }
    }

    destroy() {
        //TODO remove heosConnection.onAll listener
        this.destroyed = true;
    }
}

const IR_MAP = {
    status: 'RCSHP0230030',
    btPair: 'RCKSK0410751',
};

const REMOTE_KEYS = {
    up: 'MNCUP',
    down: 'MNCDN',
    left: 'MNCLT',
    right: 'MNCRT',
    enter: 'MNENT',
    back: 'MNRTN',
    options: 'MNOPT',
    info: 'MNINF'
};

const TOGGLE = {
    TRUE: 'ON',
    FALSE: 'OFF'
};

class ZoneProperty extends HEOSProperty {
    async setValue(value) {
        if(value === this.value) {
            return value;
        }
        await this.checkValue(value);
        switch(this.name) {
            case 'on':
                await this.device.parent.sendCommand(`${this.device.zone}${DenonProperty.formatToggle(value)}`);
                break;
            case 'input':
                await this.device.parent.sendCommand(`${this.device.zone}${value}`);
                break;
            case 'volume':
                const stringValue = DenonProperty.formatVolume(value);
                await this.device.parent.sendCommand(`${this.device.zone}${stringValue}`);
                break;
            case 'muted':
                await this.device.parent.sendCommand(`${this.device.zone}MU${DenonProperty.formatToggle(value)}`);
                break;
        }
        this.setCachedValueAndNotify(value);
        return value;
    }
}

class DenonZone extends Device {
    constructor(adapter, parent, zoneId, zoneName) {
        super(adapter, parent.id + zoneId);
        this.name = `${parent.name} ${zoneName}`;
        this['@type'] = [ 'OnOffSwitch' ];
        this.isZone = true;
        this.parent = parent;
        this.zone = zoneId;

        this.addProperty(new ZoneProperty(this, 'on', {
            title: 'Power',
            type: 'boolean',
            '@type': 'OnOffProperty'
        }));
        this.addProperty(new ZoneProperty(this, 'input', {
            title: 'Input',
            type: 'string',
            enum: [
                'SOURCE', // follow main zone source
                'PHONO',
                'CD',
                'DVD',
                'BD',
                'TV',
                'SAT/CBL',
                'MPLAY',
                'GAME',
                'TUNER',
                'AUX1',
                'AUX2',
                'NET',
                'BT'
            ],
        }));
        this.addProperty(new ZoneProperty(this, 'volume', {
            title: 'Volume',
            type: 'number',
            minimum: 0,
            maximum: 98,
            multipleOf: 0.5,
            '@type': 'LevelProperty'
        }));
        this.addProperty(new ZoneProperty(this, 'muted', {
            title: 'Muted',
            type: 'boolean'
        }));


        this.parent.ready.then(() => this.adapter.handleDeviceAdded(this));
    }

    async initDenonProperties() {
        await this.parent.sendCommand(`${this.zone}?`);
        await this.parent.sendCommand(`${this.zone}MU?`);
    }

    async handleDenonInfo(message) {
        const withoutZone = message.slice(this.zone.length);
        if(withoutZone.startsWith('MU')) {
            this.findProperty('muted').setCachedValueAndNotify(message.endsWith(TOGGLE.TRUE));
            return true;
        }
        const number = Number.parseInt(withoutZone);
        if(!Number.isNaN(number)) {
            const parsedVolume = DenonDevice.parseVolume(withoutZone);
            this.findProperty('volume').setCachedValueAndNotify(parsedVolume);
            return true;
        }
        if(withoutZone === TOGGLE.TRUE || withoutZone === TOGGLE.FALSE) {
            if(withoutZone === TOGGLE.TRUE) {
                await this.parent.initDenonProperties();
            }
            this.findProperty('on').setCachedValueAndNotify(withoutZone === TOGGLE.TRUE);
            return true;
        }
        if(this.findProperty('input').enum.includes(withoutZone)) {
            this.findProperty('input').setCachedValueAndNotify(withoutZone);
            return true;
        }

        return false;
    }

    destroy() {
        if(this.parent) {
            this.adapter.removeThing(this.parent);
            this.parent.zone2 = undefined;
        }
    }
}

class DenonProperty extends HEOSProperty {
    static formatVolume(value) {
        const intPart = Math.floor(value);
        let stringValue = intPart.toFixed(0).padStart(2, '0');
        if(intPart !== value) {
            stringValue += '5';
        }
        return stringValue;
    }

    static formatToggle(value) {
        return value ? TOGGLE.TRUE : TOGGLE.FALSE;
    }

    async setValue(value) {
        if(value === this.value) {
            return value;
        }
        await this.checkValue(value);
        switch(this.name) {
            case 'on':
                await this.device.sendCommand(`ZM${DenonProperty.formatToggle(value)}`);
                break;
            case 'audysseyLFC':
                await this.device.sendCommand(`PSLFC ${DenonProperty.formatToggle(value)}`);
                break;
            case 'band':
                await this.device.sendCommand(`TMAN${value}`);
                break;
            case 'preset':
                await this.device.sendCommand(`TPAN${value.toFixed(0).padStart(2, '0')}`);
                break;
            case 'tunerFrequency':
                await this.device.sendCommand(`TFAN${(value * 100).toFixed(0).padStart(6, '0')}`);
                break;
            case 'volume':
                const stringValue = DenonProperty.formatVolume(value);
                await this.device.sendCommand(`MV${stringValue}`);
                break;
            case 'muted':
                await this.device.sendCommand(`MU${DenonProperty.formatToggle(value)}`);
                break;
            case 'avrSource':
                await this.device.sendCommand(`SI${value}`);
                break;
            case 'surroundMode':
                await this.device.sendCommand(`MS${value}`);
                break;
        }
        this.setCachedValueAndNotify(value);
        return value;
    }
}

class DenonDevice extends HEOSDevice {
    static parseVolume(volume) {
        let parsedVolume = Number.parseInt(volume.slice(0, 2));
        if(volume.length > 2) {
            parsedVolume += Number.parseInt(volume.slice(2)) / (10 * volume.length - 2);
        }
        return parsedVolume;
    }

    buildSchema() {
        this['@type'] = [ 'OnOffSwitch' ];
        super.buildSchema();

        this.disconnectedListener = () => {
            this.connectedNotify(false);
        };
        this.connectedListener = () => {
            console.log('connected');
            this.connectedNotify(true);
            this.updateState().catch(console.error);
        };
        const decoder = new TextDecoder();
        this.rawListener = (buffer) => {
            this.handleDenonInfo(decoder.decode(buffer)).catch((error) => {
                console.error('raw', error);
            });
        }
        this.updateAVR(this.avr);
        this.isAVR = true;
        this.replacedProperties = ['volume', 'muted'];

        //TODO control ZM instead of PW with this?
        this.addProperty(new DenonProperty(this, 'on', {
            title: 'Power',
            type: 'boolean',
            '@type': 'OnOffProperty'
        }));
        //TODO granular volume properties
        this.addProperty(new DenonProperty(this, 'avrSource', {
            title: 'AVR Input',
            type: 'string',
            enum: [
                'PHONO',
                'CD',
                'DVD',
                'BD',
                'TV',
                'SAT/CBL',
                'MPLAY',
                'GAME',
                'TUNER',
                'AUX1',
                'AUX2',
                'NET', // HEOS -> expand into heos?
                'BT'
            ],
        }));
        this.addProperty(new DenonProperty(this, 'volume', {
            title: 'Volume',
            type: 'number',
            minimum: 0,
            multipleOf: 0.5,
            maximum: 98,
            '@type': 'LevelProperty'
        }));
        this.addProperty(new DenonProperty(this, 'muted', {
            title: 'Muted',
            type: 'boolean'
        }));
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
        this.addProperty(new DenonProperty(this, 'audioOutput', {
            title: 'Audio Output',
            type: 'string',
            enum: [
                'Speaker',
                'Bluetooth Headphones'
            ],
            readOnly: true
        }))

        this.addProperty(new DenonProperty(this, 'surroundMode', {
            title: 'Surround Mode',
            type: 'string',
            enum: [
                'MOVIE',
                'MUSIC',
                'GAME',
                'DIRECT',
                'PURE DIRECT',
                'STEREO',
                'AUTO',
                'DOLBY DIGITAL',
                'DTS SURROUND',
                'MCH STEREO',
                'ROCK ARENA',
                'JAZZ CLUB',
                'MONO MOVIE',
                'MATRIX',
                'VIDEO GAME',
                'VIRTUAL'
            ]
        }));
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

        this.addAction('remote', {
            title: 'Remote',
            input: {
                type: 'string',
                enum: Object.keys(REMOTE_KEYS)
            }
        });
        //TODO hold 3 sec
        // this.addAction('btPair', {
        //     title: 'Bluetooth Pairing'
        // });
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
            title: 'Band',
            type: 'string',
            enum: [
                'AM',
                'FM'
            ]
        }));

        this.zone2 = new DenonZone(this.adapter, this, 'Z2', 'Zone 2');
        //TODO remove zone2 with this since they're dependent? Also update offline state in sync.
    }

    async updateAVR(avr) {
        if(!this.avr || avr.address !== this.avr.addrss) {
            this.avr = avr;
            if(this.denonDevice) {
                try {
                    this.denonDevice.off('connect', this.connectedListener);
                    this.denonDevice.off('data', this.rawListener);
                    this.denonDevice.off('close', this.disconnectedListener);
                    this.denonDevice.disconnect();
                }
                catch(error) {
                    console.warn(error);
                }
            }
            this.ready = new Promise((resolve) => {
                this.denonDevice = net.createConnection(23, this.avr.address, resolve);
            });
            this.denonDevice.on('close', this.disconnectedListener);
            this.denonDevice.on('connect', this.connectedListener);
            this.denonDevice.on('data', this.rawListener);
        }
        else {
            this.avr = avr;
        }
    }

    async sendCommand(message) {
        await new Promise((resolve, reject) => {
            this.denonDevice.write(message, 'ascii', (error) => {
                if(error) {
                    reject(error);
                }
                else {
                    resolve();
                }
            });
        });
    }

    async updateState() {
        await Promise.all([
            super.updateState(),
            this.ready
        ]);
        await this.sendCommand('PW?');
        await this.sendCommand('ZM?');
    }

    async initDenonProperties() {
        if(this.initedProperties) {
            return;
        }
        this.initedProperties = true;
        await this.sendCommand('PSLFC?');
        await this.sendCommand('TFAN?');
        await this.sendCommand('TFANNAME?');
        await this.sendCommand('TPAN?');
        await this.sendCommand('TMAN?');
        await this.sendCommand('MV?');
        await this.sendCommand('MU?');
        await this.sendCommand('MS?');
        await this.sendCommand('SI?');
        await this.sendCommand('OPTXM?');
        await this.zone2.initDenonProperties();
    }

    async handleDenonInfo(message) {
        if(message.split('\r').length > 2) {
            for(const actualMessage of message.split('\r')) {
                if(actualMessage) {
                    await this.handleDenonInfo(`${actualMessage}\r`);
                }
            }
            return;
        }
        // strip \r
        message = message.slice(0, -1);
        if(message.startsWith('PSLFC')) {
            this.findProperty('audysseyLFC').setCachedValueAndNotify(message.endsWith(' ON'));
        }
        else if(message.startsWith('TFANNAME')) {
            const name = message.slice(8).trim();
            const source = await this.getProperty('avrSource');
            this.overrideStation = source !== 'NET';
            if(source !== 'TUNER') {
                // Ignore RDS while we aren't listening to the tuner (might be relevant for z2 though)
                return;
            }
            this.findProperty('station').setCachedValueAndNotify(name);
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
        else if(message.startsWith('MV')) {
            const volume = message.slice(2).trim();
            const parsedVolume = DenonDevice.parseVolume(volume);
            this.findProperty('volume').setCachedValueAndNotify(parsedVolume);
        }
        else if(message.startsWith('MU')) {
            this.findProperty('muted').setCachedValueAndNotify(message.endsWith(TOGGLE.TRUE));
        }
        else if(message.startsWith('SI')) {
            const source = message.slice(2);
            if(source !== 'NET' && source !== 'TUNER') {
                this.findProperty('station').setCachedValueAndNotify('');
            }
            this.findProperty('avrSource').setCachedValueAndNotify(source);
        }
        else if(message.startsWith('MS')) {
            this.findProperty('surroundMode').setCachedValueAndNotify(message.slice(2));
        }
        else if(message.startsWith('ZM')) {
            if(message.endsWith(TOGGLE.TRUE)) {
                await this.initDenonProperties();
            }
            this.findProperty('on').setCachedValueAndNotify(message.endsWith(TOGGLE.TRUE));
        }
        else if(message === 'PWSTANDBY') {
            this.findProperty('on').setCachedValueAndNotify(false);
            this.zone2.findProperty('on').setCachedValueAndNotify(false);
        }
        else if(message === 'PWON') {
            if(!this.initedProperties) {
                await this.sendCommand('ZM?');
                await this.sendCommand('Z2?');
            }
        }
        else if(message.startsWith('OPTXM')) {
            const [, value ] = message.split(' ');
            if(value.trim() === 'CON') {
                this.findProperty('audioOutput').setCachedValueAndNotify('Bluetooth Headphones');
            }
            else if(value.trim() === 'DIS') {
                this.findProperty('audioOutput').setCachedValueAndNotify('Speaker');
            }
        }
        else if(message.startsWith(this.zone2.zone) && this.zone2.handleDenonInfo(message)) {
            // message handled by zone2
        }
        else {
            console.log(message);
        }
    }

    /**
     *
     * @param {Action} action
     */
    async performAction(action) {
        if(IR_MAP.hasOwnProperty(action.name)) {
            return this.sendCommand(IR_MAP[action.name]);
        }
        switch(action.name) {
            case 'remote':
                await this.sendCommand(REMOTE_KEYS[action.input]);
                break;
            case 'seekUp':
                await this.sendCommand('TFANUP');
                break;
            case 'seekUp':
                await this.sendCommand('TFANDOWN');
                break;
            default:
                return super.performAction(action);
        }
    }

    destroy() {
        super.destroy();
        if(this.zone2) {
            this.adapter.removeThing(this.zone2);
            this.zone2.parent = undefined;
        }
        this.denonDevice.off('raw', this.rawListener);
        this.denonDevice.off('connected', this.connectedListener);
        this.denonDevice.off('disconnected', this.disconnectedListener);
        this.denonDevice.disconnect();
    }

    connectedNotify(state) {
        this.zone2.connectedNotify(state);
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
            try {
                await this.initSources();
            }
            catch(error) {
                console.warn('error updating source', error);
            }
            this.heosConnection.onClose(() => {
                this.heosConnection = null;
                for(const device of Object.values(this.devices)) {
                    if(!device.isAVR && !device.isZone) {
                        device.connectedNotify(false);
                    }
                }
            });
            this.heosConnection.on({ commandGroup: 'event', command: 'sources_changed' }, () => {
                this.initSources().catch(console.error);
            });
            this.heosConnection.on({ commandGroup: 'event', command: 'players_changed' }, () => {
                this._startPairing().catch(console.error);
            });
            for(const device of Object.values(this.devices)) {
                if(!device.isZone) {
                    device.hasHeosConnectionListener = false;
                    try {
                        await device.updateState()
                    }
                    catch(error) {
                        console.error('error updating state of', device.id, error);
                    }
                }
            }
        }
        return this.heosConnection;
    }

    async initSources() {
        const message = await this.makeHeosRequest('browser', 'get_music_sources');
        this.sourceInfo = message.payload.filter((source) => source.available == 'true');
        const sourceEnum = this.sourceInfo.map((source) => source.name);
        for(const device of Object.values(this.devices)) {
            if(!device.isZone) {
                device.findProperty('source').enum = sourceEnum;
            }
        }
    }

    startPairing(timeoutInS = 60) {
        super.startPairing();
        this._startPairing(timeoutInS).catch(console.error);
    }

    cancelPairing() {
        super.cancelPairing();
        if(this.pairingTimeout) {
            clearTimeout(this.pairingTimeout);
            this.pairingTimeout = undefined;
        }
        if(this.ssdpClient) {
            this.ssdpClient.stop();
            this.ssdpClient = undefined;
        }
    }

    async getHeosPlayers(timeoutInS) {
        await this.ensureHeosConnection(timeoutInS);
        const message = await this.makeHeosRequest('player', 'get_players');
        return message.payload;
    }

    async getDenonAVRs(timeoutInS) {
        this.ssdpClient = new Client();
        this.ssdpClient.on('response', async (meta, status, networkInfo) => {
            const request = await fetch(meta.LOCATION);
            if(request.ok && request.status == 200) {
                const xml = await request.text();
                const parsed = xmlParser.parse(xml);
                try {
                    const heosConnection = await heos.connect(networkInfo.address);
                    if(!this.heosConnection) {
                        this.heosConnection = heosConnection;
                    }
                    const heosPlayers = await new Promise((resolve, reject) => {
                        heosConnection.once({
                            commandGroup: 'player',
                            command: 'get_players'
                        }, (message) => {
                            if(message && message.heos && message.heos.result === 'success') {
                                resolve(message.payload);
                            }
                            else {
                                reject(message);
                            }
                        });
                        heosConnection.write('player', 'get_players');
                    });
                    const heosPlayer = heosPlayers.find((player) => player.serial === parsed.root.device.serialNumber) || heosPlayers[0];
                    this.onDiscover(heosPlayer, {
                        address: networkInfo.address,
                        serial: parsed.root.device.serialNumber,
                        name: parsed.root.device.friendlyName,
                        model: parsed.root.device.modelName,
                        uuid: parsed.root.device.UDN
                    });
                }
                catch(error) {
                    console.error(error);
                    this.sendPairingPrompt(`Please enable HEOS for AVR at ${networkInfo.address} (${parsed.root.device.friendlyName})`);
                }
            }
        });
        this.ssdpClient.search('urn:schemas-denon-com:device:ACT-Denon:1');
        this.pairingTimeout = setTimeout(() => {
            this.pairingTimeout = undefined;
            if(!this.ssdpClient) {
                return;
            }
            this.ssdpClient.stop()
            this.ssdpClient = undefined;
        }, timeoutInS * S_TO_MS);
    }

    async _startPairing(timeoutInS) {
        this.getDenonAVRs(timeoutInS)
        const players = await this.getHeosPlayers(timeoutInS);
        const seenPids = new Set();
        for(const player of players) {
            this.onDiscover(player);
            seenPids.add(player.pid);
        }
        for(const player of Object.values(this.devices)) {
            if(!player.isZone && !seenPids.has(player.heosPlayer.pid)) {
                this.removeThing(player);
            }
        }
    }

    async makeHeosRequest(commandGroup, command, options, callingDevice) {
        let connection;
        let tempConnection = false;
        try {
            await this.ensureHeosConnection();
            connection = this.heosConnection;
        }
        catch(error) {
            if(callingDevice && callingDevice.isAVR) {
                connection = await heos.connect(callingDevice.avr.address);
                tempConnection = true;
            }
            else {
                throw error;
            }
        }
        return new Promise((resolve, reject) => {
            connection.once({
                commandGroup,
                command
            }, (message) => {
                if(tempConnection) {
                    connection.close();
                }
                if(message && message.heos && message.heos.result === 'success') {
                    resolve(message);
                }
                else {
                    reject(message);
                }
            });
            connection.write(commandGroup, command, options);
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
            const device = this.getDevice(`heos-${player.pid}`);
            if(avr && !device.isAVR) {
                this.removeThing(device);
                this.onDiscover(player, avr);
                return;
            }
            device.heosPlayer = player;
            if(device.isAVR && avr) {
                device.updateAVR(avr);
            }
            device.connectedNotify(true);
        }
    }

    handleDeviceRemoved(device) {
        device.destroy();
        super.handleDeviceRemoved(device);
    }

    unload() {
        this.cancelPairing();
        this.heosConnection.close();
        return super.unload();
    }
}

module.exports = (addonManager) => {
    new DenonAdapter(addonManager);
};
