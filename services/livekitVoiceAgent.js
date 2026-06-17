const {
    Room,
    RoomEvent,
    TrackKind,
    AudioStream,
    AudioSource,
    AudioFrame,
    LocalAudioTrack,
    TrackPublishOptions,
    TrackSource,
} = require('@livekit/rtc-node');
const { AccessToken } = require('livekit-server-sdk');
const axios = require('axios');
const FormData = require('form-data');
const AgentStorage = require('./agentStorage');
const { generateAIResponse } = require('./aiService');

const sarvamApiKey = process.env.SARVAM_API_KEY;
const livekitUrl = process.env.LIVEKIT_URL;
const livekitApiKey = process.env.LIVEKIT_API_KEY;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET;

const activeSessions = new Map();
const TTS_SAMPLE_RATE = 8000;
const INPUT_SAMPLE_RATE = 16000;

// --- Sarvam providers (in-memory, no disk files) ---

class SarvamSTTProvider {
    async transcribe(audioBuffer, filename = 'audio.wav') {
        if (!audioBuffer || audioBuffer.length === 0) return '[Silence]';
        try {
            const form = new FormData();
            form.append('file', audioBuffer, { filename });
            form.append('model', 'saaras:v3');
            const response = await axios.post(
                'https://api.sarvam.ai/speech-to-text-translate',
                form,
                { headers: { 'api-subscription-key': sarvamApiKey, ...form.getHeaders() } }
            );
            return response.data.transcript || '[Silence]';
        } catch (error) {
            console.error('[LiveKit] STT Error:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

class SarvamTTSProvider {
    async synthesize(text) {
        const ttsBody = {
            inputs: [text],
            target_language_code: 'hi-IN',
            speaker: 'shreya',
            pace: 1.0,
            speech_sample_rate: TTS_SAMPLE_RATE,
            enable_preprocessing: true,
            model: 'bulbul:v3',
        };
        const response = await axios.post('https://api.sarvam.ai/text-to-speech', ttsBody, {
            headers: { 'api-subscription-key': sarvamApiKey, 'Content-Type': 'application/json' },
        });
        return response.data.audios[0];
    }
}

function pcmToWav(pcmBuffer, sampleRate = INPUT_SAMPLE_RATE, numChannels = 1, bitsPerSample = 16) {
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([header, pcmBuffer]);
}

function wavBufferToPcm(wavBuffer) {
    let offset = 12;
    while (offset < wavBuffer.length - 8) {
        const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
        const chunkSize = wavBuffer.readUInt32LE(offset + 4);
        if (chunkId === 'data') {
            return {
                pcm: wavBuffer.subarray(offset + 8, offset + 8 + chunkSize),
                sampleRate: wavBuffer.readUInt32LE(24),
            };
        }
        offset += 8 + chunkSize;
    }
    return { pcm: wavBuffer.subarray(44), sampleRate: TTS_SAMPLE_RATE };
}

function buildSystemPrompt(agent) {
    let fullSystemPrompt =
        'You are a conversational voice AI. Speak naturally like a human on a phone call.\n' +
        'CRITICAL RULES:\n' +
        '1. NEVER use markdown, asterisks, bullet points, or special formatting.\n' +
        '2. Keep your responses extremely concise (1-2 sentences maximum).\n' +
        '3. Only ask ONE simple question at a time.\n' +
        '4. Be warm and conversational.\n\n' +
        'AGENT INSTRUCTIONS:\n' +
        agent.systemPrompt +
        '\n\n';

    if (agent.rules?.length) fullSystemPrompt += 'SPECIFIC RULES:\n- ' + agent.rules.join('\n- ') + '\n\n';
    if (agent.faqs?.length) {
        fullSystemPrompt +=
            'FAQs:\n' +
            agent.faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join('\n') +
            '\n\n';
    }
    if (agent.closingMessage) {
        fullSystemPrompt += `When finishing the conversation, always say: "${agent.closingMessage}"`;
    }
    return fullSystemPrompt;
}

// --- PCM VAD: detect speech end by listening for quiet audio ---

class PcmVoiceActivityDetector {
    constructor(onSpeechStart, onSpeechEnd, sampleRate = INPUT_SAMPLE_RATE) {
        this.onSpeechStart = onSpeechStart;
        this.onSpeechEnd = onSpeechEnd;
        this.sampleRate = sampleRate;
        this.energyThreshold = parseInt(process.env.VAD_ENERGY_THRESHOLD, 10) || 400;
        this.silenceThresholdMs = parseInt(process.env.VAD_SILENCE_THRESHOLD, 10) || 800;
        this.isSpeaking = false;
        this.audioChunks = [];
        this.preRoll = [];
        this.quietMs = 0;
        this.maxPreRoll = 5;
    }

    frameToBuffer(frame) {
        return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    }

    frameEnergy(frame) {
        const samples = new Int16Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength / 2
        );
        if (samples.length === 0) return 0;
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
        return Math.sqrt(sumSquares / samples.length);
    }

    frameDurationMs(frame) {
        const sampleCount = frame.data.byteLength / 2;
        return (sampleCount / this.sampleRate) * 1000;
    }

    processFrame(frame) {
        const energy = this.frameEnergy(frame);
        const isLoud = energy > this.energyThreshold;
        const chunk = this.frameToBuffer(frame);
        const frameMs = this.frameDurationMs(frame);

        if (isLoud) {
            if (!this.isSpeaking) {
                const started = this.onSpeechStart();
                if (started) {
                    this.isSpeaking = true;
                    this.quietMs = 0;
                    this.audioChunks = [...this.preRoll, chunk];
                    this.preRoll = [];
                }
            } else {
                this.quietMs = 0;
                this.audioChunks.push(chunk);
            }
        } else if (this.isSpeaking) {
            this.audioChunks.push(chunk);
            this.quietMs += frameMs;
            if (this.quietMs >= this.silenceThresholdMs) {
                this.endSpeech();
            }
        } else {
            this.preRoll.push(chunk);
            if (this.preRoll.length > this.maxPreRoll) this.preRoll.shift();
        }
    }

    endSpeech() {
        if (!this.isSpeaking) return;
        this.isSpeaking = false;
        this.quietMs = 0;
        const pcm = Buffer.concat(this.audioChunks);
        this.audioChunks = [];
        this.onSpeechEnd(pcm);
    }

    reset() {
        this.isSpeaking = false;
        this.audioChunks = [];
        this.preRoll = [];
        this.quietMs = 0;
    }
}

// --- LiveKit bot session ---

class LiveKitVoiceAgent {
    constructor(roomName, agentId) {
        this.roomName = roomName;
        this.agentId = agentId;
        this.agent = AgentStorage.getAgent(agentId);
        if (!this.agent) throw new Error('Agent not found');

        this.room = new Room();
        this.stt = new SarvamSTTProvider();
        this.tts = new SarvamTTSProvider();
        this.isAISpeaking = false;
        this.interrupted = false;
        this.abortController = null;
        this.isProcessing = false;
        this.audioSource = null;
        this.audioTrack = null;
        this.userStreamAborter = null;

        this.chatHistory = [{ role: 'system', content: buildSystemPrompt(this.agent) }];
        if (this.agent.greeting) {
            this.chatHistory.push({ role: 'assistant', content: this.agent.greeting });
        }

        this.vad = new PcmVoiceActivityDetector(
            () => this.handleSpeechStart(),
            (pcm) => this.handleSpeechEnd(pcm)
        );
    }

    async connect() {
        const token = await createParticipantToken(this.roomName, 'voice-agent-bot', 'Voice Agent Bot');
        await this.room.connect(livekitUrl, token, { autoSubscribe: true, dynacast: true });

        this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind !== TrackKind.KIND_AUDIO) return;
            if (participant.identity === 'voice-agent-bot') return;
            this.subscribeToUserAudio(track);
        });

        this.room.on(RoomEvent.ParticipantConnected, (participant) => {
            if (participant.identity === 'voice-agent-bot') return;
            participant.trackPublications.forEach((publication) => {
                if (publication.track && publication.track.kind === TrackKind.KIND_AUDIO) {
                    this.subscribeToUserAudio(publication.track);
                }
            });
        });

        this.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
            if (participant.identity !== 'voice-agent-bot') {
                this.cleanup();
            }
        });

        await this.setupAudioOutput();

        console.log(`[LiveKit] Bot joined room ${this.roomName} for agent ${this.agentId}`);
        if (this.agent.greeting) {
            await this.streamTTS(this.agent.greeting);
        }
    }

    async setupAudioOutput() {
        this.audioSource = new AudioSource(TTS_SAMPLE_RATE, 1);
        this.audioTrack = LocalAudioTrack.createAudioTrack('agent-voice', this.audioSource);
        const options = new TrackPublishOptions();
        options.source = TrackSource.SOURCE_MICROPHONE;
        await this.room.localParticipant.publishTrack(this.audioTrack, options);
    }

    subscribeToUserAudio(track) {
        if (this.userStreamAborter) this.userStreamAborter.abort();
        this.userStreamAborter = new AbortController();
        const { signal } = this.userStreamAborter;

        const stream = new AudioStream(track, { sampleRate: INPUT_SAMPLE_RATE, numChannels: 1 });

        (async () => {
            try {
                for await (const frame of stream) {
                    if (signal.aborted) break;
                    this.vad.processFrame(frame);
                }
            } catch (err) {
                if (!signal.aborted) console.error('[LiveKit] Audio stream error:', err.message);
            }
        })();
    }

    sendData(payload) {
        try {
            const data = new TextEncoder().encode(JSON.stringify(payload));
            this.room.localParticipant.publishData(data, { reliable: true });
        } catch (err) {
            console.error('[LiveKit] Failed to send data:', err.message);
        }
    }

    handleSpeechStart() {
        if (this.isAISpeaking) {
            console.log(`[LiveKit] User interrupted AI in room ${this.roomName}`);
            this.interrupted = true;
            this.isAISpeaking = false;
            if (this.abortController) this.abortController.abort();
            this.sendData({ type: 'interrupt' });
            return true;
        }
        if (this.isProcessing) return false;
        console.log(`[LiveKit] User started speaking in room ${this.roomName}`);
        return true;
    }

    async handleSpeechEnd(pcmBuffer) {
        if (pcmBuffer.length < 500 || this.isProcessing) return;

        this.isProcessing = true;
        this.interrupted = false;

        try {
            this.sendData({ type: 'status', message: 'Transcribing...' });
            const wavBuffer = pcmToWav(pcmBuffer, INPUT_SAMPLE_RATE);
            const userText = await this.stt.transcribe(wavBuffer, 'speech.wav');

            if (!userText || userText.includes('[Silence]') || userText.trim() === '') {
                this.sendData({ type: 'status', message: 'Idle' });
                return;
            }

            this.sendData({ type: 'transcript', text: userText });
            if (this.interrupted) return;

            this.sendData({ type: 'status', message: 'Thinking...' });
            this.chatHistory.push({ role: 'user', content: userText });
            let aiText = await generateAIResponse(this.chatHistory, false);
            if (!aiText || aiText.trim() === '') aiText = "I'm sorry, I couldn't process that.";
            if (aiText.length > 490) aiText = aiText.substring(0, 490);
            this.chatHistory.push({ role: 'assistant', content: aiText });

            if (this.interrupted) return;
            await this.streamTTS(aiText);
        } catch (error) {
            console.error(`[LiveKit] Turn error in ${this.roomName}:`, error.message);
            this.sendData({ type: 'error', message: 'Failed to process audio' });
        } finally {
            this.isProcessing = false;
            if (!this.isAISpeaking) this.sendData({ type: 'status', message: 'Idle' });
        }
    }

    async streamTTS(aiText) {
        this.isAISpeaking = true;
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        this.sendData({ type: 'status', message: 'Speaking...' });
        this.sendData({ type: 'aiText', text: aiText });

        const sentences = aiText.match(/[^.!?]+[.!?]+/g) || [aiText];

        for (const sentence of sentences) {
            if (signal.aborted || this.interrupted) break;
            const trimmed = sentence.trim();
            if (!trimmed) continue;

            try {
                const base64Audio = await this.tts.synthesize(trimmed);
                if (signal.aborted || this.interrupted) break;
                await this.playWavBase64(base64Audio);
            } catch (error) {
                console.error('[LiveKit] TTS error:', error.message);
                break;
            }
        }

        this.isAISpeaking = false;
        if (!this.interrupted) this.sendData({ type: 'status', message: 'Idle' });
    }

    async playWavBase64(base64Audio) {
        const wavBuffer = Buffer.from(base64Audio, 'base64');
        const { pcm } = wavBufferToPcm(wavBuffer);
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);

        const frameSize = TTS_SAMPLE_RATE / 10; // 100ms frames
        for (let i = 0; i < samples.length; i += frameSize) {
            if (this.interrupted || this.abortController?.signal.aborted) break;
            const chunk = samples.subarray(i, Math.min(i + frameSize, samples.length));
            const frame = new AudioFrame(chunk, TTS_SAMPLE_RATE, 1, chunk.length);
            await this.audioSource.captureFrame(frame);
        }
    }

    async cleanup() {
        if (this.userStreamAborter) this.userStreamAborter.abort();
        if (this.abortController) this.abortController.abort();
        this.vad.reset();
        try {
            if (this.audioTrack) await this.audioTrack.close();
            if (this.audioSource) await this.audioSource.close();
            await this.room.disconnect();
        } catch (err) {
            console.error('[LiveKit] Cleanup error:', err.message);
        }
        activeSessions.delete(this.roomName);
        console.log(`[LiveKit] Bot left room ${this.roomName}`);
    }
}

async function createParticipantToken(roomName, identity, name) {
    const token = new AccessToken(livekitApiKey, livekitApiSecret, { identity, name });
    token.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });
    return token.toJwt();
}

function validateLiveKitConfig() {
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
        throw new Error('LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.');
    }
    if (!sarvamApiKey) {
        throw new Error('SARVAM_API_KEY is required.');
    }
}

async function joinAgentAsBot(roomName, agentId) {
    validateLiveKitConfig();
    if (activeSessions.has(roomName)) {
        return activeSessions.get(roomName);
    }

    const session = new LiveKitVoiceAgent(roomName, agentId);
    activeSessions.set(roomName, session);
    await session.connect();
    return session;
}

async function createUserJoinCredentials(agentId, identity) {
    validateLiveKitConfig();

    const agent = AgentStorage.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    const roomName = `agent-${agentId}-${Date.now()}`;
    const userIdentity = identity || `user-${Date.now()}`;

    const botPromise = joinAgentAsBot(roomName, agentId);
    const userToken = await createParticipantToken(roomName, userIdentity, 'User');

    await botPromise;

    return {
        url: livekitUrl,
        token: userToken,
        roomName,
        agentName: agent.agentName,
        greeting: agent.greeting || null,
    };
}

module.exports = {
    joinAgentAsBot,
    createUserJoinCredentials,
    activeSessions,
};
