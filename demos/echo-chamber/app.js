const CONFIG = {
    calibrationDurationMs: 1000,
    minSpeechMs: 200,
    silenceDurationMs: 900,
    maxPhraseDurationMs: 10000,
    minPhraseDurationMs: 300,
    resumeDelayMs: 170,
    thresholdMultiplier: 3,
    minimumThreshold: 0.025,
    analyserFftSize: 1024
};

const STATUS_TEXT = {
    idle: 'Choose an effect, then start listening.',
    requestingPermission: 'Waiting for microphone permission...',
    calibrating: 'Measuring background noise...',
    listening: 'Listening... say something.',
    speechDetected: 'Got it. Keep talking...',
    processing: 'Preparing your echo...',
    echoing: 'Echoing it back...',
    stopped: 'Stopped listening.'
};

class EchoChamberApp {
    constructor() {
        this.state = 'idle';
        this.selectedEffect = 'cave';
        this.audioContext = null;
        this.stream = null;
        this.micSource = null;
        this.micAnalyser = null;
        this.playbackAnalyser = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.timeData = null;
        this.backgroundRms = CONFIG.minimumThreshold;
        this.speechThreshold = CONFIG.minimumThreshold * CONFIG.thresholdMultiplier;
        this.silenceThreshold = CONFIG.minimumThreshold * 1.35;
        this.animationId = null;
        this.detectionId = null;
        this.sessionId = 0;
        this.recordingStartedAt = 0;
        this.speechCandidateAt = 0;
        this.silenceStartedAt = 0;
        this.sourceNode = null;
        this.lastBuffer = null;
        this.lastInputBuffer = null;
        this.playbackToken = 0;
        this.recordings = [];
        this.recordingId = 0;

        this.elements = {
            alertArea: document.getElementById('alertArea'),
            canvas: document.getElementById('visualizerCanvas'),
            centerLabel: document.getElementById('centerLabel'),
            effectButtons: [...document.querySelectorAll('.effect-button')],
            historyCount: document.getElementById('historyCount'),
            historyList: document.getElementById('historyList'),
            levelLabel: document.getElementById('levelLabel'),
            listenToggleButton: document.getElementById('listenToggleButton'),
            stateBadge: document.getElementById('stateBadge'),
            statusText: document.getElementById('statusText')
        };

        this.canvasContext = this.elements.canvas.getContext('2d');
        this.bindEvents();
        this.setState('idle');
        this.startVisualizer();
    }

    bindEvents() {
        this.elements.listenToggleButton.addEventListener('click', () => this.toggleListening());

        this.elements.effectButtons.forEach((button) => {
            button.addEventListener('click', () => {
                if (button.disabled) {
                    return;
                }
                this.selectedEffect = button.dataset.effect;
                this.updateEffectButtons();
                this.replayCurrentEchoWithEffect();
            });
        });

        this.elements.historyList.addEventListener('click', (event) => {
            const button = event.target.closest('[data-history-action]');
            if (!button) {
                return;
            }

            const recording = this.recordings.find((item) => item.id === Number(button.dataset.recordingId));
            if (!recording) {
                return;
            }

            if (button.dataset.historyAction === 'delete') {
                this.deleteRecording(recording.id);
                return;
            }

            if (button.dataset.historyAction === 'play') {
                if (this.state === 'processing') {
                    return;
                }
                this.playRecording(recording);
            }
        });

        window.addEventListener('resize', () => {
            this.resizeCanvas();
            this.recordings.forEach((recording) => {
                const canvas = this.elements.historyList.querySelector(`[data-waveform-id="${recording.id}"]`);
                if (canvas) {
                    drawRecordingWaveform(canvas, recording.buffer);
                }
            });
        });
        window.addEventListener('beforeunload', () => this.revokeRecordingUrls());
    }

    toggleListening() {
        if (['idle', 'stopped', 'error'].includes(this.state)) {
            this.start();
            return;
        }

        this.stop();
    }

    async start() {
        if (!this.checkSupport()) {
            return;
        }

        this.sessionId += 1;
        const activeSession = this.sessionId;
        this.clearAlert();
        this.setState('requestingPermission');

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            await this.audioContext.resume();

            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            if (activeSession !== this.sessionId) {
                return;
            }

            this.micSource = this.audioContext.createMediaStreamSource(this.stream);
            this.micAnalyser = this.audioContext.createAnalyser();
            this.micAnalyser.fftSize = CONFIG.analyserFftSize;
            this.timeData = new Uint8Array(this.micAnalyser.fftSize);
            this.micSource.connect(this.micAnalyser);

            await this.calibrate(activeSession);
            if (activeSession !== this.sessionId) {
                return;
            }

            this.setState('listening');
            this.startDetection(activeSession);
        } catch (error) {
            this.handleStartError(error);
        }
    }

    checkSupport() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.showError('This browser cannot access a microphone with getUserMedia. Try a current Chrome, Edge, Firefox, or Safari browser.');
            return false;
        }

        if (!window.AudioContext && !window.webkitAudioContext) {
            this.showError('This browser does not support the Web Audio API needed for Echo Chamber.');
            return false;
        }

        if (!window.OfflineAudioContext && !window.webkitOfflineAudioContext) {
            this.showError('This browser does not support OfflineAudioContext, so Echo Chamber cannot render voice effects here.');
            return false;
        }

        if (!window.MediaRecorder) {
            this.showError('This browser does not support MediaRecorder, so Echo Chamber cannot capture phrases here.');
            return false;
        }

        return true;
    }

    async calibrate(activeSession) {
        this.setState('calibrating');
        const readings = [];
        const startedAt = performance.now();

        while (performance.now() - startedAt < CONFIG.calibrationDurationMs) {
            if (activeSession !== this.sessionId) {
                return;
            }
            readings.push(this.getMicRms());
            await this.nextFrame();
        }

        const average = readings.reduce((sum, value) => sum + value, 0) / Math.max(readings.length, 1);
        this.backgroundRms = Math.max(average, 0.001);
        this.speechThreshold = Math.max(this.backgroundRms * CONFIG.thresholdMultiplier, CONFIG.minimumThreshold);
        this.silenceThreshold = Math.max(this.backgroundRms * 1.6, CONFIG.minimumThreshold * 0.85);
    }

    startDetection(activeSession) {
        this.cancelDetection();
        this.speechCandidateAt = 0;
        this.silenceStartedAt = 0;

        const tick = () => {
            if (activeSession !== this.sessionId || !this.micAnalyser || ['processing', 'echoing', 'stopped', 'error'].includes(this.state)) {
                return;
            }

            const now = performance.now();
            const rms = this.getMicRms();
            const aboveSpeech = rms >= this.speechThreshold;
            const belowSilence = rms <= this.silenceThreshold;

            // Speech starts only after the input stays above the calibrated threshold briefly.
            if (this.state === 'listening') {
                if (aboveSpeech) {
                    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
                        this.startRecording();
                    }
                    if (!this.speechCandidateAt) {
                        this.speechCandidateAt = now;
                    }

                    if (now - this.speechCandidateAt >= CONFIG.minSpeechMs) {
                        this.setState('speechDetected');
                        this.silenceStartedAt = 0;
                    }
                } else {
                    this.speechCandidateAt = 0;
                    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                        this.stopRecording(true);
                    }
                }
            }

            // Speech ends only after a short stretch of calibrated silence.
            if (this.state === 'speechDetected') {
                if (belowSilence) {
                    if (!this.silenceStartedAt) {
                        this.silenceStartedAt = now;
                    }
                } else {
                    this.silenceStartedAt = 0;
                }

                const phraseAge = now - this.recordingStartedAt;
                if ((this.silenceStartedAt && now - this.silenceStartedAt >= CONFIG.silenceDurationMs) || phraseAge >= CONFIG.maxPhraseDurationMs) {
                    this.stopRecording(false);
                }
            }

            this.detectionId = requestAnimationFrame(tick);
        };

        this.detectionId = requestAnimationFrame(tick);
    }

    startRecording() {
        const mimeType = this.getSupportedMimeType();
        this.recordedChunks = [];
        this.recordingStartedAt = performance.now();
        this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

        this.mediaRecorder.addEventListener('dataavailable', (event) => {
            if (event.data && event.data.size > 0) {
                this.recordedChunks.push(event.data);
            }
        });

        this.mediaRecorder.addEventListener('stop', () => this.handleRecordingStopped());
        this.mediaRecorder.addEventListener('error', () => this.showError('Recording failed. Please stop and try again.'));
        this.mediaRecorder.start();
    }

    stopRecording(discard) {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
            return;
        }

        this.discardRecording = discard;
        this.mediaRecorder.stop();
    }

    async handleRecordingStopped() {
        const duration = performance.now() - this.recordingStartedAt;
        const shouldDiscard = this.discardRecording || duration < CONFIG.minPhraseDurationMs || this.recordedChunks.length === 0;
        this.discardRecording = false;
        this.speechCandidateAt = 0;
        this.silenceStartedAt = 0;

        if (shouldDiscard) {
            if (!['stopped', 'error'].includes(this.state)) {
                this.setState('listening');
            }
            return;
        }

        const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
        await this.processAndPlay(blob, this.sessionId, duration);
    }

    async processAndPlay(blob, activeSession, durationMs) {
        this.cancelDetection();
        this.setState('processing');
        this.updateEffectButtons();

        try {
            const inputBuffer = await this.decodeBlob(blob);
            if (activeSession !== this.sessionId) {
                return;
            }

            this.lastInputBuffer = inputBuffer;
            this.addRecording(inputBuffer, durationMs);
            const processedBuffer = await this.renderEffect(inputBuffer, this.selectedEffect);
            this.lastBuffer = processedBuffer;

            if (activeSession !== this.sessionId) {
                return;
            }

            await this.playBuffer(processedBuffer, activeSession);
        } catch (error) {
            console.error(error);
            this.showAlert('Could not process that echo, so the app is ready for the next phrase.', 'warning');
            if (!['stopped', 'error'].includes(this.state)) {
                this.resumeListening(activeSession);
            }
        }
    }

    async decodeBlob(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        return this.audioContext.decodeAudioData(arrayBuffer);
    }

    async renderEffect(inputBuffer, effect) {
        const rate = this.getPlaybackRate(effect);
        const duration = Math.max(inputBuffer.duration / rate + this.getTailSeconds(effect), 0.2);
        const length = Math.ceil(duration * inputBuffer.sampleRate);
        const OfflineAudio = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const offline = new OfflineAudio(inputBuffer.numberOfChannels, length, inputBuffer.sampleRate);
        const source = offline.createBufferSource();
        source.buffer = inputBuffer;
        source.playbackRate.value = rate;

        const output = this.buildEffectGraph(offline, source, effect);
        output.connect(offline.destination);
        source.start(0);
        return offline.startRendering();
    }

    buildEffectGraph(context, source, effect) {
        if (effect === 'none' || effect === 'chipmunk') {
            return source;
        }

        if (effect === 'cave' || effect === 'micEcho' || effect === 'alien') {
            const filter = context.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = effect === 'micEcho' ? 6800 : 3600;

            const delay = context.createDelay(1.5);
            delay.delayTime.value = this.getDelayTime(effect);

            const feedback = context.createGain();
            feedback.gain.value = this.getFeedbackAmount(effect);

            const wet = context.createGain();
            wet.gain.value = this.getWetAmount(effect);

            const dry = context.createGain();
            dry.gain.value = effect === 'micEcho' ? 0.96 : 0.78;

            const merge = context.createGain();
            source.connect(dry).connect(merge);
            source.connect(filter).connect(delay).connect(wet).connect(merge);
            delay.connect(feedback).connect(delay);

            return merge;
        }

        if (effect === 'glitchEcho') {
            const dry = context.createGain();
            dry.gain.value = 0.58;

            const merge = context.createGain();
            source.connect(dry).connect(merge);

            [0.045, 0.082, 0.13, 0.19, 0.27, 0.38].forEach((delayTime, index) => {
                const delay = context.createDelay(0.7);
                const gain = context.createGain();
                const gate = context.createGain();
                const tapFilter = context.createBiquadFilter();
                const tapShaper = context.createWaveShaper();
                delay.delayTime.value = delayTime;
                gain.gain.value = [0.36, 0.34, 0.3, 0.26, 0.2, 0.16][index];
                gate.gain.setValueAtTime(0.02, 0);
                tapFilter.type = index % 2 === 0 ? 'bandpass' : 'highpass';
                tapFilter.frequency.value = 900 + index * 360;
                tapFilter.Q.value = 2.4;
                tapShaper.curve = makeDistortionCurve(55 + index * 14);

                for (let time = delayTime; time < context.length / context.sampleRate; time += 0.095) {
                    gate.gain.setValueAtTime(0.02, time);
                    gate.gain.linearRampToValueAtTime(1, time + 0.004);
                    gate.gain.setValueAtTime(1, time + 0.022 + (index % 2) * 0.012);
                    gate.gain.linearRampToValueAtTime(0.02, time + 0.034 + (index % 2) * 0.014);
                }

                source.connect(tapFilter).connect(tapShaper).connect(delay).connect(gate).connect(gain).connect(merge);
            });

            return merge;
        }

        if (effect === 'robot') {
            const carrier = context.createOscillator();
            carrier.type = 'square';
            carrier.frequency.value = 82;

            const carrierDepth = context.createGain();
            carrierDepth.gain.value = 0.26;

            const modulator = context.createGain();
            modulator.gain.value = 0.52;

            const highpass = context.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 520;

            const filter = context.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 1650;
            filter.Q.value = 5.5;

            const combDelay = context.createDelay(0.08);
            combDelay.delayTime.value = 0.018;

            const combFeedback = context.createGain();
            combFeedback.gain.value = 0.28;

            const shaper = context.createWaveShaper();
            shaper.curve = makeDistortionCurve(70);
            shaper.oversample = '2x';

            const limiter = context.createDynamicsCompressor();
            limiter.threshold.value = -28;
            limiter.knee.value = 4;
            limiter.ratio.value = 10;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.09;

            carrier.connect(carrierDepth).connect(modulator.gain);
            source.connect(highpass).connect(filter).connect(combDelay).connect(shaper).connect(limiter).connect(modulator);
            combDelay.connect(combFeedback).connect(combDelay);
            carrier.start(0);
            carrier.stop(context.currentTime + Math.max(0.1, source.buffer.duration + 0.25));
            return modulator;
        }

        if (effect === 'monster') {
            const shaper = context.createWaveShaper();
            shaper.curve = makeDistortionCurve(80);
            shaper.oversample = '2x';

            const filter = context.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 1200;

            source.connect(shaper).connect(filter);
            return filter;
        }

        if (effect === 'walkie') {
            const bandpass = context.createBiquadFilter();
            bandpass.type = 'bandpass';
            bandpass.frequency.value = 1200;
            bandpass.Q.value = 1.2;

            const shaper = context.createWaveShaper();
            shaper.curve = makeDistortionCurve(45);

            source.connect(bandpass).connect(shaper);
            return shaper;
        }

        if (effect === 'ghost') {
            const deepLayer = context.createBufferSource();
            deepLayer.buffer = source.buffer;
            deepLayer.playbackRate.value = 0.42;

            const lowLayer = context.createBufferSource();
            lowLayer.buffer = source.buffer;
            lowLayer.playbackRate.value = 0.56;

            const highLayer = context.createBufferSource();
            highLayer.buffer = source.buffer;
            highLayer.playbackRate.value = 1.42;

            const thinLayer = context.createBufferSource();
            thinLayer.buffer = source.buffer;
            thinLayer.playbackRate.value = 1.82;

            const whisperNoise = context.createBufferSource();
            whisperNoise.buffer = makeNoiseBuffer(context, source.buffer.duration + 0.8);

            const noiseFilter = context.createBiquadFilter();
            noiseFilter.type = 'bandpass';
            noiseFilter.frequency.value = 2400;
            noiseFilter.Q.value = 0.8;

            const whisper = context.createDelay(1.2);
            whisper.delayTime.value = 0.045;

            const longDelay = context.createDelay(1.8);
            longDelay.delayTime.value = 0.24;

            const feedback = context.createGain();
            feedback.gain.value = 0.24;

            const wet = context.createGain();
            wet.gain.value = 0.72;

            const noiseGain = context.createGain();
            noiseGain.gain.value = 0.035;

            const deepLayerGain = context.createGain();
            deepLayerGain.gain.value = 0.68;

            const lowLayerGain = context.createGain();
            lowLayerGain.gain.value = 0.58;

            const highLayerGain = context.createGain();
            highLayerGain.gain.value = 0.42;

            const thinLayerGain = context.createGain();
            thinLayerGain.gain.value = 0.34;

            const delaySend = context.createGain();
            delaySend.gain.value = 0.42;

            const deepLayerFilter = context.createBiquadFilter();
            deepLayerFilter.type = 'lowpass';
            deepLayerFilter.frequency.value = 620;

            const lowLayerFilter = context.createBiquadFilter();
            lowLayerFilter.type = 'lowpass';
            lowLayerFilter.frequency.value = 780;

            const highLayerFilter = context.createBiquadFilter();
            highLayerFilter.type = 'highpass';
            highLayerFilter.frequency.value = 1450;

            const thinLayerFilter = context.createBiquadFilter();
            thinLayerFilter.type = 'bandpass';
            thinLayerFilter.frequency.value = 2800;
            thinLayerFilter.Q.value = 1.2;

            const shimmer = context.createBiquadFilter();
            shimmer.type = 'peaking';
            shimmer.frequency.value = 980;
            shimmer.Q.value = 1.4;
            shimmer.gain.value = 6;

            const compressor = context.createDynamicsCompressor();
            compressor.threshold.value = -30;
            compressor.knee.value = 8;
            compressor.ratio.value = 6;
            compressor.attack.value = 0.008;
            compressor.release.value = 0.16;

            const output = context.createGain();
            output.gain.value = 1.45;

            const merge = context.createGain();
            whisper.connect(wet);
            wet.connect(shimmer).connect(merge);
            whisperNoise.connect(noiseFilter).connect(noiseGain).connect(whisper);
            deepLayer.connect(deepLayerFilter).connect(deepLayerGain).connect(merge);
            lowLayer.connect(lowLayerFilter).connect(lowLayerGain).connect(merge);
            highLayer.connect(highLayerFilter).connect(highLayerGain).connect(merge);
            thinLayer.connect(thinLayerFilter).connect(thinLayerGain).connect(merge);
            deepLayerGain.connect(delaySend);
            lowLayerGain.connect(delaySend);
            highLayerGain.connect(whisper);
            thinLayerGain.connect(whisper);
            delaySend.connect(longDelay);
            longDelay.connect(feedback).connect(longDelay);
            merge.connect(compressor).connect(output);
            deepLayer.start(0);
            lowLayer.start(0.01);
            highLayer.start(0.015);
            thinLayer.start(0.02);
            whisperNoise.start(0);
            return output;
        }

        return source;
    }

    getPlaybackRate(effect) {
        if (effect === 'chipmunk') {
            return 1.55;
        }
        if (effect === 'monster') {
            return 0.68;
        }
        if (effect === 'alien') {
            return 1.32;
        }
        if (effect === 'ghost') {
            return 1;
        }
        return 1;
    }

    getTailSeconds(effect) {
        if (effect === 'cave') {
            return 1.7;
        }
        if (effect === 'glitchEcho') {
            return 0.85;
        }
        if (effect === 'micEcho') {
            return 0.45;
        }
        if (effect === 'ghost') {
            return 2.35;
        }
        if (effect === 'alien') {
            return 0.8;
        }
        return 0.15;
    }

    getDelayTime(effect) {
        if (effect === 'alien') {
            return 0.14;
        }
        if (effect === 'micEcho') {
            return 0.085;
        }
        return 0.34;
    }

    getFeedbackAmount(effect) {
        if (effect === 'cave') {
            return 0.42;
        }
        if (effect === 'micEcho') {
            return 0.06;
        }
        return 0.28;
    }

    getWetAmount(effect) {
        if (effect === 'cave') {
            return 0.58;
        }
        if (effect === 'micEcho') {
            return 0.16;
        }
        return 0.44;
    }

    playBuffer(buffer, activeSession, token = this.playbackToken + 1) {
        return new Promise((resolve) => {
            this.playbackToken = token;
            this.setState('echoing');

            const analyser = this.audioContext.createAnalyser();
            const sourceNode = this.audioContext.createBufferSource();
            analyser.fftSize = CONFIG.analyserFftSize;
            sourceNode.buffer = buffer;
            sourceNode.connect(analyser).connect(this.audioContext.destination);
            this.playbackAnalyser = analyser;
            this.sourceNode = sourceNode;

            sourceNode.addEventListener('ended', () => {
                if (this.sourceNode === sourceNode) {
                    this.sourceNode = null;
                }
                if (this.playbackAnalyser === analyser) {
                    this.playbackAnalyser = null;
                }
                resolve();
                if (token === this.playbackToken && activeSession === this.sessionId && !['stopped', 'error'].includes(this.state)) {
                    if (this.stream) {
                        this.resumeListening(activeSession);
                    } else {
                        this.setState('stopped');
                    }
                }
            });
            sourceNode.start(0);
        });
    }

    async replayCurrentEchoWithEffect() {
        if (this.state !== 'echoing' || !this.lastInputBuffer || !this.audioContext) {
            return;
        }

        const activeSession = this.sessionId;
        const token = this.playbackToken + 1;
        this.playbackToken = token;

        if (this.sourceNode) {
            try {
                this.sourceNode.stop();
            } catch {
                // Source may already be stopped.
            }
        }

        this.setState('processing');

        try {
            const processedBuffer = await this.renderEffect(this.lastInputBuffer, this.selectedEffect);
            this.lastBuffer = processedBuffer;

            if (token !== this.playbackToken || activeSession !== this.sessionId || this.state === 'stopped') {
                return;
            }

            await this.playBuffer(processedBuffer, activeSession, token);
        } catch (error) {
            console.error(error);
            this.showAlert('Could not switch that echo effect during playback.', 'warning');
            if (activeSession === this.sessionId && this.state !== 'stopped') {
                this.resumeListening(activeSession);
            }
        }
    }

    async playRecording(recording) {
        const activeSession = this.sessionId;
        const token = this.playbackToken + 1;
        this.playbackToken = token;
        this.cancelDetection();

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.stopRecording(true);
        }

        if (this.sourceNode) {
            try {
                this.sourceNode.stop();
            } catch {
                // Source may already be stopped.
            }
        }

        try {
            await this.ensureAudioContext();
            this.lastInputBuffer = recording.buffer;
            this.setState('processing');
            const processedBuffer = await this.renderEffect(recording.buffer, this.selectedEffect);
            this.lastBuffer = processedBuffer;

            if (token !== this.playbackToken) {
                return;
            }

            await this.playBuffer(processedBuffer, activeSession, token);
        } catch (error) {
            console.error(error);
            this.showAlert('Could not play that saved echo.', 'warning');
            if (this.stream && !['stopped', 'error'].includes(this.state)) {
                this.resumeListening(activeSession);
            } else if (!this.stream) {
                this.setState('stopped');
            }
        }
    }

    async ensureAudioContext() {
        if (this.audioContext && this.audioContext.state !== 'closed') {
            await this.audioContext.resume();
            return;
        }

        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await this.audioContext.resume();
    }

    resumeListening(activeSession) {
        window.setTimeout(() => {
            if (activeSession !== this.sessionId || !this.stream || this.state === 'stopped') {
                return;
            }
            this.setState('listening');
            this.startDetection(activeSession);
        }, CONFIG.resumeDelayMs);
    }

    stop() {
        this.sessionId += 1;
        this.cancelDetection();

        if (this.sourceNode) {
            try {
                this.sourceNode.stop();
            } catch {
                // Source may already be stopped.
            }
            this.sourceNode = null;
        }
        this.playbackToken += 1;

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.stopRecording(true);
        }

        if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
        }

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }

        this.stream = null;
        this.audioContext = null;
        this.micSource = null;
        this.micAnalyser = null;
        this.playbackAnalyser = null;
        this.setState('stopped');
    }

    cancelDetection() {
        if (this.detectionId) {
            cancelAnimationFrame(this.detectionId);
            this.detectionId = null;
        }
    }

    addRecording(buffer, durationMs) {
        const wavBlob = bufferToWavBlob(buffer);
        const recording = {
            id: this.recordingId + 1,
            buffer,
            durationMs,
            url: URL.createObjectURL(wavBlob),
            filename: `echo-chamber-${this.recordingId + 1}.wav`
        };

        this.recordingId = recording.id;
        this.recordings.unshift(recording);
        this.renderHistory();
    }

    renderHistory() {
        this.elements.historyCount.textContent = `${this.recordings.length} saved`;

        if (this.recordings.length === 0) {
            this.elements.historyList.innerHTML = '<p class="text-body-secondary mb-0">Your echoes will appear here after you speak.</p>';
            return;
        }

        this.elements.historyList.innerHTML = this.recordings.map((recording) => `
            <article class="recording-item">
                <div class="min-w-0">
                    <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
                        <strong>Recording ${recording.id}</strong>
                        <span class="small text-body-secondary">${formatDuration(recording.durationMs)}</span>
                    </div>
                    <canvas class="recording-waveform" data-waveform-id="${recording.id}" aria-label="Waveform for recording ${recording.id}"></canvas>
                </div>
                <div class="recording-actions">
                    <button class="btn btn-sm btn-primary" type="button" data-history-action="play" data-recording-id="${recording.id}">Echo / Play</button>
                    <a class="btn btn-sm btn-outline-light" href="${recording.url}" download="${recording.filename}">Download</a>
                    <button class="btn btn-sm btn-outline-danger" type="button" data-history-action="delete" data-recording-id="${recording.id}">Delete</button>
                </div>
            </article>
        `).join('');

        this.recordings.forEach((recording) => {
            const canvas = this.elements.historyList.querySelector(`[data-waveform-id="${recording.id}"]`);
            if (canvas) {
                drawRecordingWaveform(canvas, recording.buffer);
            }
        });
    }

    revokeRecordingUrls() {
        this.recordings.forEach((recording) => URL.revokeObjectURL(recording.url));
    }

    deleteRecording(recordingId) {
        const recording = this.recordings.find((item) => item.id === recordingId);
        if (recording) {
            URL.revokeObjectURL(recording.url);
        }

        this.recordings = this.recordings.filter((item) => item.id !== recordingId);
        this.renderHistory();
    }

    getMicRms() {
        if (!this.micAnalyser || !this.timeData) {
            return 0;
        }
        this.micAnalyser.getByteTimeDomainData(this.timeData);
        return calculateRms(this.timeData);
    }

    getVisualizerData() {
        const analyser = this.state === 'echoing' && this.playbackAnalyser ? this.playbackAnalyser : this.micAnalyser;
        if (!analyser) {
            return null;
        }
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        return data;
    }

    startVisualizer() {
        const draw = (time) => {
            this.resizeCanvas();
            this.drawVisualizer(time);
            this.animationId = requestAnimationFrame(draw);
        };
        this.animationId = requestAnimationFrame(draw);
    }

    resizeCanvas() {
        const canvas = this.elements.canvas;
        const rect = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(Math.floor(rect.width * ratio), 1);
        const height = Math.max(Math.floor(rect.height * ratio), 1);

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    drawVisualizer(time) {
        const canvas = this.elements.canvas;
        const ctx = this.canvasContext;
        const width = canvas.width;
        const height = canvas.height;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.28;
        const data = this.getVisualizerData();
        const idlePulse = 0.5 + Math.sin(time / 520) * 0.5;
        const bars = 96;

        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(centerX, centerY);

        const gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
        gradient.addColorStop(0, '#7cc4ff');
        gradient.addColorStop(0.55, '#9ee6a8');
        gradient.addColorStop(1, '#f5a3b7');

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
        ctx.lineWidth = Math.max(width * 0.004, 1);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = gradient;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(width * 0.006, 2);

        for (let index = 0; index < bars; index += 1) {
            const angle = (index / bars) * Math.PI * 2;
            const sample = data ? Math.abs((data[Math.floor((index / bars) * data.length)] - 128) / 128) : 0;
            const stateBoost = this.state === 'speechDetected' ? 1.6 : this.state === 'echoing' ? 1.25 : 1;
            const calm = ['idle', 'stopped'].includes(this.state) ? idlePulse * 0.08 : 0;
            const processing = this.state === 'processing' ? idlePulse * 0.28 : 0;
            const length = radius * (0.16 + calm + processing + sample * 0.72 * stateBoost);
            const inner = radius - length * 0.26;
            const outer = radius + length;

            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
            ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
            ctx.stroke();
        }

        ctx.restore();

        const rms = data ? calculateRms(data) : 0;
        this.elements.levelLabel.textContent = data ? `Signal ${Math.round(rms * 100)}%` : 'No signal yet';
    }

    setState(state) {
        this.state = state;
        const label = state.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
        this.elements.stateBadge.textContent = label;
        this.elements.statusText.textContent = STATUS_TEXT[state] || this.elements.statusText.textContent;
        this.elements.centerLabel.textContent = this.getCenterLabel(state);
        this.updateListenToggleButton(state);
        this.updateEffectButtons();
    }

    updateListenToggleButton(state) {
        const button = this.elements.listenToggleButton;
        const isStarting = ['requestingPermission', 'calibrating'].includes(state);
        const isActive = ['listening', 'speechDetected', 'processing', 'echoing'].includes(state);

        button.disabled = isStarting;
        button.textContent = isActive || isStarting ? 'Stop Listening' : 'Start Listening';
        button.classList.toggle('btn-primary', !isActive);
        button.classList.toggle('btn-danger', isActive);
    }

    getCenterLabel(state) {
        const labels = {
            idle: 'Ready',
            requestingPermission: 'Permission',
            calibrating: 'Calibrating',
            listening: 'Listening',
            speechDetected: 'Caught that',
            processing: 'Processing',
            echoing: 'Echoing',
            stopped: 'Stopped',
            error: 'Error'
        };
        return labels[state] || 'Ready';
    }

    updateEffectButtons() {
        const locked = this.state === 'processing';
        this.elements.effectButtons.forEach((button) => {
            const isActive = button.dataset.effect === this.selectedEffect;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
            button.disabled = locked;
        });
    }

    handleStartError(error) {
        console.error(error);
        let message = 'Echo Chamber could not start the microphone. Please try again.';

        if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
            message = 'Microphone permission was denied. Allow microphone access and try Start Listening again.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            message = 'No microphone was found. Connect a microphone and try again.';
        } else if (error.name === 'NotReadableError') {
            message = 'The microphone is already in use by another app or tab.';
        }

        this.showError(message);
        this.stopTracksOnly();
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        this.audioContext = null;
    }

    stopTracksOnly() {
        if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
        }
        this.stream = null;
    }

    showError(message) {
        this.setState('error');
        this.elements.statusText.textContent = message;
        this.showAlert(message, 'danger');
    }

    showAlert(message, type) {
        this.elements.alertArea.innerHTML = `<div class="alert alert-${type} py-2" role="alert">${escapeHtml(message)}</div>`;
    }

    clearAlert() {
        this.elements.alertArea.innerHTML = '';
    }

    getSupportedMimeType() {
        const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
        return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    }

    nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(resolve));
    }
}

function calculateRms(data) {
    let sum = 0;
    for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] - 128) / 128;
        sum += value * value;
    }
    return Math.sqrt(sum / data.length);
}

function makeDistortionCurve(amount) {
    const samples = 44100;
    const curve = new Float32Array(samples);
    const deg = Math.PI / 180;

    for (let index = 0; index < samples; index += 1) {
        const x = (index * 2) / samples - 1;
        curve[index] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }

    return curve;
}

function reverseAudioBuffer(context, buffer) {
    const reversed = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const input = buffer.getChannelData(channel);
        const output = reversed.getChannelData(channel);

        for (let index = 0; index < input.length; index += 1) {
            output[index] = input[input.length - 1 - index];
        }
    }

    return reversed;
}

function makeNoiseBuffer(context, duration) {
    const length = Math.max(1, Math.ceil(duration * context.sampleRate));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);

    for (let index = 0; index < length; index += 1) {
        data[index] = (Math.random() * 2 - 1) * 0.42;
    }

    return buffer;
}

function drawRecordingWaveform(canvas, buffer) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(Math.floor(rect.width * ratio), 1);
    const height = Math.max(Math.floor(rect.height * ratio), 1);
    const ctx = canvas.getContext('2d');
    const data = buffer.getChannelData(0);
    const samples = 96;
    const step = Math.max(Math.floor(data.length / samples), 1);

    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#7cc4ff');
    gradient.addColorStop(0.55, '#9ee6a8');
    gradient.addColorStop(1, '#f5a3b7');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = Math.max(2 * ratio, 1);
    ctx.lineCap = 'round';

    const centerY = height / 2;
    const barWidth = width / samples;

    for (let index = 0; index < samples; index += 1) {
        let peak = 0;
        const start = index * step;
        const end = Math.min(start + step, data.length);

        for (let sample = start; sample < end; sample += 1) {
            peak = Math.max(peak, Math.abs(data[sample]));
        }

        const x = index * barWidth + barWidth / 2;
        const barHeight = Math.max(peak * height * 0.86, 2 * ratio);
        ctx.beginPath();
        ctx.moveTo(x, centerY - barHeight / 2);
        ctx.lineTo(x, centerY + barHeight / 2);
        ctx.stroke();
    }
}

function formatDuration(durationMs) {
    const seconds = Math.max(durationMs / 1000, 0);
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function bufferToWavBlob(buffer) {
    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const samples = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const dataSize = samples * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    let offset = 0;

    const writeString = (value) => {
        for (let index = 0; index < value.length; index += 1) {
            view.setUint8(offset, value.charCodeAt(index));
            offset += 1;
        }
    };

    writeString('RIFF');
    view.setUint32(offset, 36 + dataSize, true);
    offset += 4;
    writeString('WAVE');
    writeString('fmt ');
    view.setUint32(offset, 16, true);
    offset += 4;
    view.setUint16(offset, 1, true);
    offset += 2;
    view.setUint16(offset, channels, true);
    offset += 2;
    view.setUint32(offset, sampleRate, true);
    offset += 4;
    view.setUint32(offset, sampleRate * blockAlign, true);
    offset += 4;
    view.setUint16(offset, blockAlign, true);
    offset += 2;
    view.setUint16(offset, 16, true);
    offset += 2;
    writeString('data');
    view.setUint32(offset, dataSize, true);
    offset += 4;

    const channelData = [];
    for (let channel = 0; channel < channels; channel += 1) {
        channelData.push(buffer.getChannelData(channel));
    }

    for (let sample = 0; sample < samples; sample += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
            const value = Math.max(-1, Math.min(1, channelData[channel][sample]));
            view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
            offset += 2;
        }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
}

document.getElementById('current-year').textContent = new Date().getFullYear();
new EchoChamberApp();
