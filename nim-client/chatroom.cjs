'use strict';

// Adapted from yaya_msg for read-only live-room monitoring.

const crypto = require('node:crypto');
const net = require('node:net');
const zlib = require('node:zlib');

const DEFAULT_LBS_URL = 'https://lbs.netease.im/lbs/chat.jsp';
const ANDROID_SDK_VERSION = 92110;
const ANDROID_PACKAGE_NAME = 'com.seine48.app';
const RSA_KEY_VERSION = 0;
const RSA_PUBLIC_KEY = crypto.createPublicKey({
    key: Buffer.from(
        'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCBxLuL8+xpQSddSnSvPkvNOHdcr5Euqw+kkOSzO/buDMheCfFILRC/v5+nv8BsL7/YZWVpDA8sIBTxfNRqSCu0uLjlbJqT/sMnPT1xxdQrkb1HSnuSyTbZbqaInQ13tBE2SfcAhsQZJJ1hKQSE2QyKOMxQPhP583qcsIhDbdExvwIDAQAB',
        'base64'
    ),
    format: 'der',
    type: 'spki'
});

function encodeVarint(input) {
    const bytes = [];
    let value = Number(input) >>> 0;
    do {
        let byte = value & 0x7f;
        value = Math.floor(value / 128);
        if (value) byte |= 0x80;
        bytes.push(byte);
    } while (value);
    return Buffer.from(bytes);
}

function readVarint(buffer, offset = 0) {
    let value = 0;
    let scale = 1;
    for (let index = offset; index < buffer.length && index < offset + 5; index += 1) {
        const byte = buffer[index];
        value += (byte & 0x7f) * scale;
        if ((byte & 0x80) === 0) return { value, size: index - offset + 1 };
        scale *= 128;
    }
    return null;
}

function encodeBytes(input) {
    const value = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    return Buffer.concat([encodeVarint(value.length), value]);
}

function encodeProperties(input) {
    const entries = Object.entries(input)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [Number(key), value])
        .sort(([left], [right]) => left - right);
    const chunks = [encodeVarint(entries.length)];
    for (const [key, value] of entries) {
        chunks.push(encodeVarint(key), encodeBytes(value));
    }
    return Buffer.concat(chunks);
}

function decodeProperties(buffer) {
    let offset = 0;
    const count = readVarint(buffer, offset);
    if (!count) throw new Error('聊天室消息属性数量无效');
    offset += count.size;

    const properties = new Map();
    for (let index = 0; index < count.value; index += 1) {
        const key = readVarint(buffer, offset);
        if (!key) throw new Error('聊天室消息属性编号无效');
        offset += key.size;

        const length = readVarint(buffer, offset);
        if (!length) throw new Error('聊天室消息属性长度无效');
        offset += length.size;
        if (offset + length.value > buffer.length) throw new Error('聊天室消息属性不完整');

        properties.set(key.value, buffer.subarray(offset, offset + length.value).toString('utf8'));
        offset += length.value;
    }
    return properties;
}

function decodePropertyBuffers(buffer) {
    let offset = 0;
    const count = readVarint(buffer, offset);
    if (!count || count.value > 1024) throw new Error('聊天室属性数量无效');
    offset += count.size;

    const properties = new Map();
    for (let index = 0; index < count.value; index += 1) {
        const key = readVarint(buffer, offset);
        if (!key) throw new Error('聊天室属性编号无效');
        offset += key.size;

        const length = readVarint(buffer, offset);
        if (!length) throw new Error('聊天室属性长度无效');
        offset += length.size;
        if (offset + length.value > buffer.length) throw new Error('聊天室属性内容不完整');
        properties.set(key.value, buffer.subarray(offset, offset + length.value));
        offset += length.value;
    }
    if (offset !== buffer.length) throw new Error('聊天室属性内容存在尾部数据');
    return properties;
}

function readOnlineMemberNum(buffer, depth = 0) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || depth > 4) return null;
    let properties;
    try {
        properties = decodePropertyBuffers(buffer);
    } catch (_error) {
        return null;
    }

    const direct = properties.get(101);
    if (direct) {
        const text = direct.toString('utf8').trim();
        if (/^\d{1,10}$/.test(text)) return Number(text);
    }
    for (const value of properties.values()) {
        const nested = readOnlineMemberNum(value, depth + 1);
        if (nested !== null) return nested;
    }
    return null;
}

function extractOnlineMemberNum(body) {
    const source = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
    for (let offset = 0; offset < Math.min(source.length, 8); offset += 1) {
        const value = readOnlineMemberNum(source.subarray(offset));
        if (value !== null) return value;
    }
    return null;
}

function makePacket(serviceId, commandId, serial, body = Buffer.alloc(0), tag = 0) {
    const header = Buffer.allocUnsafe(5);
    header[0] = serviceId;
    header[1] = commandId;
    header.writeInt16LE(serial, 2);
    header[4] = tag;
    return Buffer.concat([encodeVarint(header.length + body.length), header, body]);
}

function decodePacket(raw, options = {}) {
    const frameLength = readVarint(raw);
    if (!frameLength
        || (!options.embedded && raw.length < frameLength.size + frameLength.value)
        || (!options.embedded && frameLength.value < 5)
        || (options.embedded && raw.length < frameLength.size + 5)) {
        throw new Error('聊天室数据包不完整');
    }

    let offset = frameLength.size;
    const serviceId = raw[offset];
    const commandId = raw[offset + 1];
    const serial = raw.readInt16LE(offset + 2);
    const tag = raw[offset + 4];
    offset += 5;

    let resultCode = 200;
    if (tag & 2) {
        if (offset + 2 > raw.length) throw new Error('聊天室响应状态不完整');
        resultCode = raw.readInt16LE(offset);
        offset += 2;
    }

    const packetEnd = options.embedded
        ? raw.length
        : Math.min(raw.length, frameLength.size + frameLength.value);
    let body = raw.subarray(offset, packetEnd);
    if (tag & 1) {
        if (body.length < 4) throw new Error('聊天室压缩数据不完整');
        const expectedLength = body.readInt32LE(0);
        body = zlib.inflateSync(body.subarray(4));
        if (body.length !== expectedLength) throw new Error('聊天室压缩数据长度不一致');
    }
    return { serviceId, commandId, serial, resultCode, body };
}

function decodeEmbeddedPacket(raw) {
    const frameLength = readVarint(raw);
    if (!frameLength || raw.length < frameLength.size + 5) return null;
    return decodePacket(raw, { embedded: true });
}

class Rc4Stream {
    constructor(key) {
        if (!key?.length) throw new Error('聊天室加密密钥无效');
        this.state = Uint8Array.from({ length: 256 }, (_, index) => index);
        this.x = 0;
        this.y = 0;
        let cursor = 0;
        for (let index = 0; index < 256; index += 1) {
            cursor = (cursor + this.state[index] + key[index % key.length]) & 0xff;
            [this.state[index], this.state[cursor]] = [this.state[cursor], this.state[index]];
        }
    }

    apply(input) {
        const output = Buffer.allocUnsafe(input.length);
        for (let index = 0; index < input.length; index += 1) {
            this.x = (this.x + 1) & 0xff;
            this.y = (this.y + this.state[this.x]) & 0xff;
            [this.state[this.x], this.state[this.y]] = [this.state[this.y], this.state[this.x]];
            output[index] = input[index] ^ this.state[(this.state[this.x] + this.state[this.y]) & 0xff];
        }
        return output;
    }
}

function encryptHandshakePayload(payload) {
    const blocks = [];
    for (let offset = 0; offset < payload.length; offset += 117) {
        blocks.push(crypto.publicEncrypt({
            key: RSA_PUBLIC_KEY,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, payload.subarray(offset, offset + 117)));
    }
    return Buffer.concat(blocks);
}

function littleEndianInt32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32LE(value);
    return buffer;
}

function parseExtension(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
        return {};
    }
}

function normalizeMessage(properties) {
    const messageType = Number(properties.get(2) ?? -1);
    const attachment = properties.get(3) || '';
    const custom = properties.get(4) || '';
    return {
        uuid: properties.get(1) || '',
        type: messageType === 0 ? 'text' : 'custom',
        msg_type_: messageType,
        msg_attach_: attachment,
        msg_setting_: { ext_: custom },
        custom,
        remoteExtension: parseExtension(custom),
        fromNick: properties.get(7) || '',
        fromAvatar: properties.get(8) || '',
        text: messageType === 0 ? attachment : (properties.get(13) || ''),
        from: properties.get(21) || '',
        sessionId: properties.get(22) || '',
        fromClientType: Number(properties.get(23) || 0),
        time: Number(properties.get(20) || 0)
    };
}

function parseTcpAddress(value) {
    const address = String(value || '').trim();
    const separator = address.lastIndexOf(':');
    const host = address.slice(0, separator).replace(/^\[|\]$/g, '');
    const port = Number(address.slice(separator + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('云信没有返回有效的聊天室 TCP 地址');
    }
    return { host, port };
}

class NimCommonlinkChatroomClient {
    constructor(options = {}) {
        this.appKey = String(options.appKey || '').trim();
        this.account = String(options.account || '').trim();
        this.token = String(options.token || '').trim();
        this.roomId = String(options.roomId || '').trim();
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.lbsUrl = String(options.lbsUrl || DEFAULT_LBS_URL);
        this.onConnected = options.onConnected;
        this.onReconnecting = options.onReconnecting;
        this.onDisconnected = options.onDisconnected;
        this.onMessage = options.onMessage;
        this.onError = options.onError;
        // 🔴 全包观察者：chatroom 层原先只认 13/7(消息)、13/6(发送回执)、13/13(房间信息)，
        //    其余 13/* 通知（成员进出、状态变更等）全部静默丢弃。
        //    追查「打开 App 上线」信号必须能看到这些包，故统一透传（默认关闭，不影响生产）。
        //    签名：(packet, via) => void，via = 'frame' | 'embedded'
        this.onRawPacket = options.onRawPacket;
        this.stopped = true;
        this.connected = false;
        this.serial = 1;
        this.reconnectAttempt = 0;
        this.seenMessageIds = new Set();
        this.pendingRequests = new Map();
        this.pendingRoomInfoRequests = new Map();
    }

    async connect() {
        if (!this.appKey || !this.account || !this.token || !/^\d{1,32}$/.test(this.roomId)) {
            throw new Error('缺少有效的聊天室 AppKey、账号、令牌或房间 ID');
        }
        if (typeof this.fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持聊天室地址请求');
        this.stopped = false;
        await this.#openConnection();
    }

    disconnect() {
        this.stopped = true;
        this.connected = false;
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.reconnectTimer);
        this.socket?.destroy();
        this.#rejectPendingRequests(new Error('直播聊天室连接已关闭'));
    }

    destroy() {
        this.disconnect();
    }

    async getChatroomInfo() {
        if (!this.connected || !this.socket || this.socket.destroyed || !this.encryptor) {
            throw new Error('直播聊天室尚未连接');
        }
        const serial = this.#nextSerial();
        const packet = makePacket(13, 13, serial);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRoomInfoRequests.delete(serial);
                reject(new Error('读取聊天室在线人数超时'));
            }, 12_000);
            timeout.unref?.();
            this.pendingRoomInfoRequests.set(serial, { resolve, reject, timeout });
            this.socket.write(this.encryptor.apply(packet), error => {
                if (!error) return;
                const pending = this.pendingRoomInfoRequests.get(serial);
                if (!pending) return;
                this.pendingRoomInfoRequests.delete(serial);
                clearTimeout(pending.timeout);
                reject(error);
            });
        });
    }

    async #requestAddress() {
        const url = new URL(this.lbsUrl);
        url.search = new URLSearchParams({
            k: this.appKey,
            id: this.account,
            rid: this.roomId,
            v: String(ANDROID_SDK_VERSION),
            tp: '1',
            dt: '0',
            nt: '2'
        }).toString();
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`获取聊天室地址失败：HTTP ${response.status}`);
        const result = await response.json();
        return parseTcpAddress(Array.isArray(result?.link) ? result.link[0] : '');
    }

    #nextSerial() {
        const value = this.serial;
        this.serial = value >= 32767 ? 1 : value + 1;
        return value;
    }

    #makeEnterPacket(deviceId) {
        const login = encodeProperties({
            1: this.appKey,
            2: this.account,
            3: deviceId,
            5: this.roomId,
            8: 1
        });
        const authentication = encodeProperties({
            3: 1,
            4: '8.0.0',
            6: ANDROID_SDK_VERSION,
            9: 1,
            13: deviceId,
            18: this.appKey,
            19: this.account,
            25: ANDROID_PACKAGE_NAME,
            1000: this.token
        });
        return makePacket(13, 2, this.#nextSerial(), Buffer.concat([Buffer.from([2]), login, authentication]));
    }

    #makeHandshake(key, enterPacket) {
        const payload = Buffer.concat([encodeBytes(key), enterPacket]);
        return makePacket(1, 1, 0, Buffer.concat([
            littleEndianInt32(RSA_KEY_VERSION),
            encryptHandshakePayload(payload)
        ]));
    }

    async #openConnection() {
        const address = await this.#requestAddress();
        if (this.stopped) throw new Error('直播聊天室连接已取消');
        const encryptionKey = crypto.randomBytes(16);
        const enterPacket = this.#makeEnterPacket(crypto.randomUUID());
        const handshake = this.#makeHandshake(encryptionKey, enterPacket);
        this.encryptor = new Rc4Stream(encryptionKey);
        this.decryptor = new Rc4Stream(encryptionKey);
        this.receiveBuffer = Buffer.alloc(0);

        await new Promise((resolve, reject) => {
            let enterSent = false;
            let settled = false;
            const settleError = (error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };
            const connectTimer = setTimeout(() => {
                const error = new Error('连接直播聊天室超时');
                settleError(error);
                this.socket?.destroy();
            }, 20_000);
            connectTimer.unref?.();

            this.socket = net.createConnection(address);
            this.socket.setKeepAlive(true, 15_000);
            this.socket.setTimeout(45_000, () => {
                this.#reportError(new Error('直播聊天室心跳超时'));
                this.socket?.destroy();
            });
            this.socket.on('connect', () => this.socket.write(handshake));
            this.socket.on('data', chunk => {
                try {
                    this.receiveBuffer = Buffer.concat([this.receiveBuffer, this.decryptor.apply(chunk)]);
                    while (this.receiveBuffer.length) {
                        const length = readVarint(this.receiveBuffer);
                        if (!length) break;
                        const packetLength = length.size + length.value;
                        if (this.receiveBuffer.length < packetLength) break;
                        const raw = this.receiveBuffer.subarray(0, packetLength);
                        this.receiveBuffer = this.receiveBuffer.subarray(packetLength);
                        let response = decodePacket(raw);

                        if (response.serviceId === 4
                            && [1, 2, 10, 11].includes(response.commandId)
                            && response.body.length > 8) {
                            const embedded = decodeEmbeddedPacket(response.body.subarray(8));
                            if (embedded) {
                                response = embedded;
                                this.#emitRaw(response, 'embedded');
                            } else {
                                this.#emitRaw(response, 'frame');
                                continue;
                            }
                        } else {
                            this.#emitRaw(response, 'frame');
                        }

                        if (response.serviceId === 1 && response.commandId === 1) {
                            if (response.resultCode !== 200) {
                                throw new Error(`聊天室握手失败：${response.resultCode}`);
                            }
                            if (!enterSent) {
                                enterSent = true;
                                this.socket.write(this.encryptor.apply(enterPacket));
                            }
                            continue;
                        }

                        if (response.serviceId === 13 && response.commandId === 2) {
                            if (response.resultCode !== 200) {
                                throw new Error(`进入直播聊天室失败：${response.resultCode}`);
                            }
                            if (!settled) {
                                settled = true;
                                clearTimeout(connectTimer);
                                this.connected = true;
                                this.reconnectAttempt = 0;
                                this.#startHeartbeat();
                                this.onConnected?.();
                                resolve();
                            }
                            continue;
                        }

                        if (response.serviceId === 13 && response.commandId === 7) {
                            this.#handleMessage(response.body);
                        }
                        if (response.serviceId === 13 && response.commandId === 6) {
                            this.#handleSendResult(response);
                        }
                        if (response.serviceId === 13 && response.commandId === 13) {
                            this.#handleChatroomInfoResult(response);
                        }
                    }
                } catch (error) {
                    this.#reportError(error);
                    settleError(error);
                    this.socket?.destroy();
                }
            });
            this.socket.on('error', error => {
                this.#reportError(error);
                settleError(error);
            });
            this.socket.on('close', () => {
                clearTimeout(connectTimer);
                clearInterval(this.heartbeatTimer);
                this.#rejectPendingRequests(new Error('发送弹幕时聊天室连接已断开'));
                const wasConnected = this.connected;
                this.connected = false;
                if (!settled) settleError(new Error('直播聊天室连接已关闭'));
                if (wasConnected && !this.stopped) {
                    this.onDisconnected?.();
                    this.#scheduleReconnect();
                }
            });
        });
    }

    #handleMessage(body) {
        const properties = decodeProperties(body);
        const message = normalizeMessage(properties);
        if (message.uuid && this.seenMessageIds.has(message.uuid)) return;
        if (message.uuid) {
            this.seenMessageIds.add(message.uuid);
            if (this.seenMessageIds.size > 2048) {
                this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
            }
        }
        this.onMessage?.(message);

        if (properties.get(38) === '1' && message.uuid && this.socket && !this.socket.destroyed) {
            const acknowledgment = makePacket(
                13,
                35,
                this.#nextSerial(),
                encodeProperties({ 1: message.uuid, 2: this.roomId })
            );
            this.socket.write(this.encryptor.apply(acknowledgment));
        }
    }

    #handleSendResult(response) {
        const pending = this.pendingRequests.get(response.serial);
        if (!pending) return;
        this.pendingRequests.delete(response.serial);
        clearTimeout(pending.timeout);
        if (response.resultCode !== 200) {
            pending.reject(new Error(`${pending.failureMessage}：${response.resultCode}`));
            return;
        }

        let serverMessage = null;
        if (response.body.length) {
            try {
                serverMessage = normalizeMessage(decodeProperties(response.body));
            } catch (_error) {
            }
        }
        pending.resolve({
            success: true,
            idClient: pending.idClient,
            text: pending.content,
            time: Number(serverMessage?.time || Date.now())
        });
    }

    #handleChatroomInfoResult(response) {
        const pending = this.pendingRoomInfoRequests.get(response.serial);
        if (!pending) return;
        this.pendingRoomInfoRequests.delete(response.serial);
        clearTimeout(pending.timeout);
        if (response.resultCode !== 200) {
            pending.reject(new Error(`读取聊天室在线人数失败：${response.resultCode}`));
            return;
        }
        const onlineMemberNum = extractOnlineMemberNum(response.body);
        if (onlineMemberNum === null) {
            pending.reject(new Error('聊天室没有返回在线人数'));
            return;
        }
        pending.resolve({ onlineMemberNum });
    }

    #rejectPendingRequests(error) {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingRequests.clear();
        for (const pending of this.pendingRoomInfoRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingRoomInfoRequests.clear();
    }

    #startHeartbeat() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            if (!this.connected || !this.socket || this.socket.destroyed) return;
            this.socket.write(this.encryptor.apply(makePacket(1, 2, this.#nextSerial())));
        }, 15_000);
        this.heartbeatTimer.unref?.();
    }

    #scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        const delay = Math.min(30_000, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
        this.reconnectAttempt += 1;
        this.onReconnecting?.({ attempt: this.reconnectAttempt, delay });
        this.reconnectTimer = setTimeout(() => {
            if (this.stopped) return;
            void this.#openConnection().catch(error => {
                this.#reportError(error);
                if (!this.stopped) this.#scheduleReconnect();
            });
        }, delay);
        this.reconnectTimer.unref?.();
    }

    #emitRaw(packet, via) {
        if (!this.onRawPacket) return;
        try {
            this.onRawPacket(packet, via);
        } catch (error) {
            this.#reportError(error);
        }
    }

    #reportError(error) {
        try {
            this.onError?.(error);
        } catch (_callbackError) {
        }
    }
}

function createNimCommonlinkChatroomClient(options) {
    return new NimCommonlinkChatroomClient(options);
}

module.exports = {
    NimCommonlinkChatroomClient,
    createNimCommonlinkChatroomClient,
    extractOnlineMemberNum,
    normalizeMessage,
    encodeProperties,
    decodeProperties
};
