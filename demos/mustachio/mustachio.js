const MEDIAPIPE_VERSION = '0.10.22-rc.20250304';
const MODEL_PATH = './models/face_landmarker.task';
const READY_MESSAGES = [
    { progress: 10, text: 'Warming up the mustache machine...' },
    { progress: 35, text: 'Loading MediaPipe files...' },
    { progress: 70, text: 'Loading face landmark model...' },
    { progress: 90, text: 'Getting the doodle pen ready...' },
    { progress: 100, text: 'Ready for a face.' }
];
const MUSTACHE_STYLES = {
    villain: { label: 'Villain Curl', render: drawVillainCurl },
    brush: { label: 'Bold Brush', render: drawBoldBrush },
    walrus: { label: 'Walrus', render: drawWalrus },
    pencil: { label: 'Pencil Line', render: drawPencilLine },
    handlebar: { label: 'Handlebar', render: drawHandlebar },
    cartoon: { label: 'Cartoon Puff', render: drawCartoonPuff }
};
const SECRET_SAMPLES = [
    {
        src: 'samples/randy-wedding.jpg',
        name: 'Randy wedding sample portrait',
        alt: 'Wedding portrait of Randy',
        label: 'Randy'
    },
    {
        src: 'samples/andrea-wedding.jpg',
        name: 'Andrea wedding sample portrait',
        alt: 'Wedding portrait of Andrea',
        label: 'Andrea'
    },
    {
        src: 'samples/kaitlin-2024.jpg',
        name: 'Kaitlin 2024 sample portrait',
        alt: '2024 school portrait of Kaitlin',
        label: 'Kaitlin'
    },
    {
        src: 'samples/liam-2024.jpg',
        name: 'Liam 2024 sample portrait',
        alt: '2024 school portrait of Liam',
        label: 'Liam'
    },
    {
        src: 'samples/nora-2024.jpg',
        name: 'Nora 2024 sample portrait',
        alt: '2024 school portrait of Nora',
        label: 'Nora'
    },
    {
        src: 'samples/olive-2024.jpg',
        name: 'Olive 2024 sample portrait',
        alt: '2024 school portrait of Olive',
        label: 'Olive'
    }
];

const elements = {
    readyBadge: document.getElementById('readyBadge'),
    statusText: document.getElementById('statusText'),
    progressWrap: document.getElementById('progressWrap'),
    statusProgress: document.getElementById('statusProgress'),
    alertArea: document.getElementById('alertArea'),
    photoInput: document.getElementById('photoInput'),
    choosePhotoButton: document.getElementById('choosePhotoButton'),
    randomSampleButton: document.getElementById('randomSampleButton'),
    clearButton: document.getElementById('clearButton'),
    dropZone: document.getElementById('dropZone'),
    sampleSecretTrigger: document.getElementById('sampleSecretTrigger'),
    secretUnlocked: document.getElementById('secretUnlocked'),
    previewCard: document.querySelector('.preview-card'),
    canvasWrap: document.getElementById('canvasWrap'),
    canvas: document.getElementById('photoCanvas'),
    imageBadge: document.getElementById('imageBadge'),
    sampleButtons: Array.from(document.querySelectorAll('.sample-button')),
    styleButtons: Array.from(document.querySelectorAll('.style-button')),
    currentYear: document.getElementById('current-year')
};

const ctx = elements.canvas.getContext('2d');

let faceLandmarker = null;
let isReady = false;
let currentImage = null;
let currentObjectUrl = null;
let imageKey = '';
let detectionCache = null;
let pickedFace = null;
let animationFrameId = 0;
let drawRunId = 0;
let mustacheProgress = 0;
let selectedMustacheStyle = 'villain';
let sampleTitleTaps = 0;
let sampleTitleTapTimer = 0;
let secretSamplesUnlocked = false;

elements.currentYear.textContent = new Date().getFullYear();

init();

async function init() {
    wireEvents();
    setControlsEnabled(false);
    setProgress(READY_MESSAGES[0]);

    try {
        setProgress(READY_MESSAGES[1]);
        const { FaceLandmarker, FilesetResolver } = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`);

        setProgress(READY_MESSAGES[2]);
        const vision = await FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`);

        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: MODEL_PATH,
                delegate: 'CPU'
            },
            runningMode: 'IMAGE',
            numFaces: 4
        });

        setProgress(READY_MESSAGES[3]);
        await wait(220);
        setProgress(READY_MESSAGES[4]);
        isReady = true;
        elements.readyBadge.className = 'badge text-bg-success';
        elements.readyBadge.textContent = 'Ready';
        setControlsEnabled(true);
    } catch (error) {
        console.error(error);
        elements.readyBadge.className = 'badge text-bg-danger';
        elements.readyBadge.textContent = 'Error';
        setStatus('The mustache machine could not start.');
        showAlert('danger', `MediaPipe could not load. Make sure ${MODEL_PATH} exists and the page can reach the MediaPipe CDN files.`);
    }
}

function wireEvents() {
    elements.choosePhotoButton.addEventListener('click', () => elements.photoInput.click());
    elements.photoInput.addEventListener('change', () => {
        const file = elements.photoInput.files?.[0];
        if (file) {
            loadImageFile(file);
        }
    });

    elements.randomSampleButton.addEventListener('click', () => {
        const samples = getAvailableSampleButtons();
        const sample = samples[Math.floor(Math.random() * samples.length)];
        loadImageUrl(sample.dataset.sampleSrc, sample.dataset.sampleName);
    });

    elements.sampleSecretTrigger.addEventListener('click', handleSampleTitleTap);

    elements.sampleButtons.forEach((button) => {
        button.addEventListener('click', () => loadImageUrl(button.dataset.sampleSrc, button.dataset.sampleName));
    });

    elements.styleButtons.forEach((button) => {
        button.addEventListener('click', () => {
            selectedMustacheStyle = button.dataset.style;
            updateStyleButtons();
            drawMustache();
        });
    });

    elements.clearButton.addEventListener('click', clearMustache);

    elements.dropZone.addEventListener('click', () => {
        if (isReady) {
            elements.photoInput.click();
        }
    });

    elements.dropZone.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && isReady) {
            event.preventDefault();
            elements.photoInput.click();
        }
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
        elements.dropZone.addEventListener(eventName, (event) => {
            event.preventDefault();
            if (isReady) {
                elements.dropZone.classList.add('is-dragging');
            }
        });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
        elements.dropZone.addEventListener(eventName, () => elements.dropZone.classList.remove('is-dragging'));
    });

    elements.dropZone.addEventListener('drop', (event) => {
        event.preventDefault();
        if (!isReady) {
            return;
        }

        const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'));
        if (file) {
            loadImageFile(file);
        } else {
            showAlert('warning', 'Drop an image file and I will give it a proper little mustache.');
        }
    });

    document.addEventListener('paste', (event) => {
        if (!isReady) {
            return;
        }

        const file = Array.from(event.clipboardData?.files || []).find((item) => item.type.startsWith('image/'));
        if (file) {
            loadImageFile(file);
        }
    });

    window.addEventListener('resize', debounce(() => {
        if (currentImage) {
            renderCanvas(mustacheProgress);
        }
    }, 120));
}

function setControlsEnabled(enabled) {
    [
        elements.photoInput,
        elements.choosePhotoButton,
        elements.randomSampleButton,
        ...elements.styleButtons,
        ...elements.sampleButtons
    ].forEach((control) => {
        control.disabled = !enabled;
    });

    elements.dropZone.classList.toggle('is-disabled', !enabled);
    updateSampleButtonAvailability();
    updateStyleButtons();
    updateActionButtons();
}

function getAvailableSampleButtons() {
    return elements.sampleButtons.filter((button) => !button.hidden);
}

function updateSampleButtonAvailability() {
    elements.sampleButtons.forEach((button) => {
        button.disabled = !isReady || button.hidden;
    });
}

function handleSampleTitleTap() {
    if (secretSamplesUnlocked) {
        return;
    }

    clearTimeout(sampleTitleTapTimer);
    sampleTitleTaps += 1;

    if (sampleTitleTaps >= 3) {
        unlockSecretSamples();
        return;
    }

    sampleTitleTapTimer = window.setTimeout(() => {
        sampleTitleTaps = 0;
    }, 1100);
}

function unlockSecretSamples() {
    secretSamplesUnlocked = true;
    sampleTitleTaps = 0;
    clearTimeout(sampleTitleTapTimer);

    elements.sampleButtons.forEach((button, index) => {
        const secretSample = SECRET_SAMPLES[index];
        if (!secretSample) {
            button.hidden = true;
            button.classList.add('d-none');
            button.disabled = true;
            return;
        }

        updateSampleButton(button, secretSample);
        button.hidden = false;
        button.classList.remove('d-none');
    });

    elements.secretUnlocked.classList.remove('d-none');
    setProgress({ progress: 100, text: 'Secret samples unlocked.' });
    updateSampleButtonAvailability();
}

function updateSampleButton(button, sample) {
    const image = button.querySelector('img');
    const label = button.querySelector('span');

    button.dataset.sampleSrc = sample.src;
    button.dataset.sampleName = sample.name;
    image.src = sample.src;
    image.alt = sample.alt;
    label.textContent = sample.label;
}

function updateActionButtons() {
    const hasImage = Boolean(currentImage);
    elements.styleButtons.forEach((button) => {
        button.disabled = !isReady || !hasImage;
    });
    elements.clearButton.disabled = !hasImage || mustacheProgress === 0;
}

function setProgress(stage) {
    setStatus(stage.text);
    elements.progressWrap.setAttribute('aria-valuenow', stage.progress);
    elements.statusProgress.style.width = `${stage.progress}%`;
    elements.statusProgress.textContent = `${stage.progress}%`;
}

function setStatus(message) {
    elements.statusText.textContent = message;
}

function getSelectedStyleLabel() {
    return (MUSTACHE_STYLES[selectedMustacheStyle] || MUSTACHE_STYLES.villain).label;
}

function updateStyleButtons() {
    elements.styleButtons.forEach((button) => {
        const isActive = button.dataset.style === selectedMustacheStyle;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
    });
}

function scrollPreviewIntoViewOnMobile() {
    if (!window.matchMedia('(max-width: 991.98px)').matches) {
        return;
    }

    window.setTimeout(() => {
        elements.previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
}

function showAlert(type, message) {
    elements.alertArea.innerHTML = `
        <div class="alert alert-${type} alert-dismissible fade show" role="alert">
            ${escapeHtml(message)}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        </div>
    `;
}

function clearAlert() {
    elements.alertArea.innerHTML = '';
}

async function loadImageFile(file) {
    if (!file.type.startsWith('image/')) {
        showAlert('warning', 'That does not look like an image file. Try a JPG, PNG, GIF, or WebP photo.');
        return;
    }

    const objectUrl = URL.createObjectURL(file);
    await loadImageUrl(objectUrl, file.name, true);
}

async function loadImageUrl(src, name, isObjectUrl = false) {
    try {
        setProgress({ progress: 20, text: 'Reading image...' });
        clearAlert();
        cancelAnimationFrame(animationFrameId);
        drawRunId += 1;

        const image = await decodeImage(src);
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
        }

        currentObjectUrl = isObjectUrl ? src : null;
        currentImage = image;
        imageKey = `${src}-${image.naturalWidth}x${image.naturalHeight}-${Date.now()}`;
        detectionCache = null;
        pickedFace = null;
        mustacheProgress = 0;

        elements.canvasWrap.classList.add('has-image');
        elements.imageBadge.textContent = name || 'Custom photo';
        setProgress({ progress: 100, text: 'Photo loaded. Ready to draw.' });
        renderCanvas(0);
        updateActionButtons();
        scrollPreviewIntoViewOnMobile();
    } catch (error) {
        console.error(error);
        showAlert('danger', 'I could not load that image. Try another photo.');
        setProgress({ progress: 100, text: 'Ready for another photo.' });
    }
}

function decodeImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
    });
}

async function drawMustache() {
    if (!currentImage || !faceLandmarker) {
        return;
    }

    const runId = startFreshDraw();

    try {
        elements.styleButtons.forEach((button) => {
            button.disabled = true;
        });
        setProgress({ progress: 45, text: 'Looking for a face...' });
        clearAlert();

        const result = detectionCache?.imageKey === imageKey
            ? detectionCache.result
            : faceLandmarker.detect(currentImage);

        detectionCache = { imageKey, result };

        const faces = result.faceLandmarks || [];
        if (faces.length === 0) {
            pickedFace = null;
            renderCanvas(0);
            showAlert('warning', 'I couldn\'t find a face in this photo. Try a clearer, front-facing picture.');
            setProgress({ progress: 100, text: 'Ready for another photo.' });
            return;
        }

        pickedFace = pickLargestFace(faces);
        if (faces.length > 1) {
            showAlert('info', 'I found more than one face, so I picked the largest one for now.');
        }

        setProgress({ progress: 72, text: 'Planning the mustache...' });
        await wait(120);
        if (runId !== drawRunId) {
            return;
        }

        setProgress({ progress: 86, text: 'Drawing...' });
        animateMustache(runId);
    } catch (error) {
        console.error(error);
        showAlert('danger', 'The face detector tripped over its own shoelaces. Try another photo or reload the page.');
        setProgress({ progress: 100, text: 'Ready for another photo.' });
    } finally {
        updateActionButtons();
    }
}

function startFreshDraw() {
    drawRunId += 1;
    cancelAnimationFrame(animationFrameId);
    mustacheProgress = 0;
    renderCanvas(0);
    return drawRunId;
}

function pickLargestFace(faces) {
    return faces
        .map((face) => {
            const bounds = face.reduce((box, point) => ({
                minX: Math.min(box.minX, point.x),
                minY: Math.min(box.minY, point.y),
                maxX: Math.max(box.maxX, point.x),
                maxY: Math.max(box.maxY, point.y)
            }), { minX: 1, minY: 1, maxX: 0, maxY: 0 });

            return {
                face,
                area: (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
            };
        })
        .sort((a, b) => b.area - a.area)[0].face;
}

function animateMustache(runId) {
    cancelAnimationFrame(animationFrameId);
    const startedAt = performance.now();
    const duration = 1550;

    function tick(now) {
        if (runId !== drawRunId) {
            return;
        }

        const rawProgress = Math.min((now - startedAt) / duration, 1);
        mustacheProgress = easeInOutCubic(rawProgress);
        renderCanvas(mustacheProgress);

        if (rawProgress < 1) {
            animationFrameId = requestAnimationFrame(tick);
        } else {
            setProgress({ progress: 100, text: `${getSelectedStyleLabel()} has arrived.` });
            updateActionButtons();
        }
    }

    animationFrameId = requestAnimationFrame(tick);
}

function clearMustache() {
    cancelAnimationFrame(animationFrameId);
    drawRunId += 1;
    mustacheProgress = 0;
    renderCanvas(0);
    setProgress({ progress: 100, text: 'Mustache cleared. The face is respectable again.' });
    updateActionButtons();
}

function renderCanvas(progress = 0) {
    if (!currentImage) {
        return;
    }

    const maxWidth = Math.max(elements.canvasWrap.clientWidth - 2, 280);
    const maxHeight = Math.min(Math.max(window.innerHeight * 0.68, 360), 760);
    const imageRatio = currentImage.naturalWidth / currentImage.naturalHeight;
    let cssWidth = maxWidth;
    let cssHeight = cssWidth / imageRatio;

    if (cssHeight > maxHeight) {
        cssHeight = maxHeight;
        cssWidth = cssHeight * imageRatio;
    }

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    elements.canvas.style.width = `${cssWidth}px`;
    elements.canvas.style.height = `${cssHeight}px`;
    elements.canvas.width = Math.round(cssWidth * dpr);
    elements.canvas.height = Math.round(cssHeight * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.drawImage(currentImage, 0, 0, cssWidth, cssHeight);

    if (pickedFace && progress > 0) {
        drawHandDrawnMustache(pickedFace, cssWidth, cssHeight, progress);
    }
}

function drawHandDrawnMustache(landmarks, canvasWidth, canvasHeight, progress) {
    const placement = getMustachePlacement(landmarks, canvasWidth, canvasHeight);
    if (!placement) {
        return;
    }

    const style = MUSTACHE_STYLES[selectedMustacheStyle] || MUSTACHE_STYLES.villain;

    ctx.save();
    ctx.translate(placement.x, placement.y);
    ctx.rotate(placement.rotation);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    style.render(placement.scale, progress);

    ctx.restore();
}

function getMustachePlacement(landmarks, canvasWidth, canvasHeight) {
    const noseBase = pointFromLandmark(landmarks[2], canvasWidth, canvasHeight);
    const mouthLeft = pointFromLandmark(landmarks[61], canvasWidth, canvasHeight);
    const mouthRight = pointFromLandmark(landmarks[291], canvasWidth, canvasHeight);
    const leftEye = pointFromLandmark(landmarks[33], canvasWidth, canvasHeight);
    const rightEye = pointFromLandmark(landmarks[263], canvasWidth, canvasHeight);

    if (!noseBase || !mouthLeft || !mouthRight || !leftEye || !rightEye) {
        return null;
    }

    // MediaPipe landmarks are normalized to the source image. Since the canvas
    // draws the image at the same aspect ratio, each landmark maps directly into
    // canvas coordinates by multiplying x and y by the fitted canvas size.
    const mouthCenter = midpoint(mouthLeft, mouthRight);
    const eyeDistance = distance(leftEye, rightEye);
    const mouthWidth = distance(mouthLeft, mouthRight);
    const rotation = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
    const scale = clamp(Math.max(mouthWidth * 0.72, eyeDistance * 0.36), 34, Math.min(canvasWidth, canvasHeight) * 0.22);

    return {
        x: (noseBase.x * 0.54) + (mouthCenter.x * 0.46),
        y: (noseBase.y * 0.58) + (mouthCenter.y * 0.42),
        rotation,
        scale
    };
}

function drawVillainCurl(scale, progress) {
    const sideProgress = Math.min(progress * 1.12, 1);
    drawVillainSide(-1, scale, sideProgress);
    drawVillainSide(1, scale, sideProgress);
    drawCenterKnot(scale, progress, 0.15, 0.08);
}

function drawBoldBrush(scale, progress) {
    const sideProgress = Math.min(progress * 1.1, 1);
    drawCurvedHalf(-1, scale, sideProgress, {
        length: 0.96,
        lift: 0.02,
        droop: 0.08,
        wave: 0.03,
        width: 0.28
    });
    drawCurvedHalf(1, scale, sideProgress, {
        length: 0.98,
        lift: 0.025,
        droop: 0.075,
        wave: 0.035,
        width: 0.29
    });
    drawCenterKnot(scale, progress, 0.2, 0.12);
}

function drawWalrus(scale, progress) {
    const sideProgress = Math.min(progress * 1.08, 1);
    drawCurvedHalf(-1, scale, sideProgress, {
        length: 0.88,
        lift: 0.08,
        droop: 0.42,
        wave: 0.06,
        width: 0.31
    });
    drawCurvedHalf(1, scale, sideProgress, {
        length: 0.9,
        lift: 0.085,
        droop: 0.44,
        wave: 0.055,
        width: 0.32
    });
    drawCenterKnot(scale, progress, 0.22, 0.16);
}

function drawPencilLine(scale, progress) {
    const sideProgress = Math.min(progress * 1.18, 1);
    drawCurvedHalf(-1, scale, sideProgress, {
        length: 1.02,
        lift: -0.015,
        droop: 0.04,
        wave: 0.025,
        width: 0.055,
        highlight: false
    });
    drawCurvedHalf(1, scale, sideProgress, {
        length: 1.02,
        lift: -0.015,
        droop: 0.04,
        wave: 0.025,
        width: 0.055,
        highlight: false
    });
    drawCenterKnot(scale, progress, 0.08, 0.05);
}

function drawHandlebar(scale, progress) {
    const sideProgress = Math.min(progress * 1.08, 1);
    drawHandlebarSide(-1, scale, sideProgress);
    drawHandlebarSide(1, scale, sideProgress);
    drawCenterKnot(scale, progress, 0.13, 0.07);
}

function drawCartoonPuff(scale, progress) {
    const puffProgress = Math.min(progress * 1.15, 1);
    drawCartoonPuffHalf(-1, scale, puffProgress, 0.96);
    drawCartoonPuffHalf(1, scale, puffProgress, 1.04);
    drawCenterKnot(scale, progress, 0.18, 0.1);
}

function drawVillainSide(direction, scale, progress) {
    const bodyProgress = Math.min(progress / 0.72, 1);
    const curlProgress = clamp((progress - 0.48) / 0.52, 0, 1);
    const start = { x: direction * scale * 0.07, y: scale * 0.03 };
    const c1 = { x: direction * scale * 0.34, y: scale * -0.27 };
    const c2 = { x: direction * scale * 0.78, y: scale * -0.31 };
    const end = { x: direction * scale * 1.08, y: scale * -0.2 };

    drawCubicStroke(start, c1, c2, end, bodyProgress, Math.max(scale * 0.13, 5), true);

    if (curlProgress > 0) {
        drawSpiralCurl({
            direction,
            centerX: direction * scale * 1.02,
            centerY: scale * -0.1,
            radius: scale * 0.28,
            turns: 1.1,
            startAngle: direction > 0 ? -1.35 : Math.PI + 1.35,
            progress: curlProgress,
            lineWidth: Math.max(scale * 0.1, 4.5)
        });
    }
}

function drawHandlebarSide(direction, scale, progress) {
    const bodyProgress = Math.min(progress / 0.7, 1);
    const droopProgress = clamp((progress - 0.46) / 0.54, 0, 1);
    const start = { x: direction * scale * 0.06, y: scale * 0.02 };
    const c1 = { x: direction * scale * 0.36, y: scale * -0.08 };
    const c2 = { x: direction * scale * 0.74, y: scale * -0.04 };
    const edge = { x: direction * scale * 0.98, y: scale * 0.12 };

    drawCubicStroke(start, c1, c2, edge, bodyProgress, Math.max(scale * 0.14, 6), true);

    if (droopProgress > 0) {
        const downC1 = { x: direction * scale * 1.12, y: scale * 0.28 };
        const downC2 = { x: direction * scale * 1.02, y: scale * 0.62 };
        const tip = { x: direction * scale * 0.84, y: scale * 0.78 };

        drawCubicStroke(edge, downC1, downC2, tip, droopProgress, Math.max(scale * 0.115, 5), true);
    }
}

function drawCubicStroke(start, control1, control2, end, progress, lineWidth, highlight = false) {
    const segments = 46;
    const visibleSegments = Math.max(1, Math.ceil(segments * clamp(progress, 0, 1)));
    const points = [];

    for (let index = 0; index <= segments; index++) {
        points.push(cubicPoint(start, control1, control2, end, index / segments));
    }

    ctx.strokeStyle = '#0d0b0a';
    ctx.lineWidth = lineWidth;
    strokeVisiblePoints(points, visibleSegments);

    if (highlight) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = Math.max(lineWidth * 0.16, 1.25);
        strokeVisiblePoints(points.map((point) => ({ x: point.x, y: point.y - lineWidth * 0.22 })), visibleSegments);
    }
}

function drawSpiralCurl({ direction, centerX, centerY, radius, turns, startAngle, progress, lineWidth }) {
    const segments = 56;
    const visibleSegments = Math.max(1, Math.ceil(segments * clamp(progress, 0, 1)));
    const points = [];

    for (let index = 0; index <= segments; index++) {
        const t = index / segments;
        const angle = startAngle + direction * Math.PI * 2 * turns * t;
        const currentRadius = radius * (1 - 0.58 * t);

        points.push({
            x: centerX + Math.cos(angle) * currentRadius,
            y: centerY + Math.sin(angle) * currentRadius
        });
    }

    ctx.strokeStyle = '#0d0b0a';
    ctx.lineWidth = lineWidth;
    strokeVisiblePoints(points, visibleSegments);
}

function drawCartoonPuffHalf(direction, scale, progress, wobble) {
    ctx.save();
    ctx.globalAlpha = clamp(progress, 0, 1);
    ctx.scale(progress, progress);
    ctx.translate(direction * scale * 0.42, scale * 0.03);

    ctx.fillStyle = '#0d0b0a';
    ctx.strokeStyle = '#0d0b0a';
    ctx.lineWidth = Math.max(scale * 0.055, 3);
    ctx.beginPath();
    ctx.moveTo(direction * scale * -0.32, 0);
    ctx.bezierCurveTo(direction * scale * -0.12, scale * -0.27 * wobble, direction * scale * 0.5, scale * -0.24, direction * scale * 0.72, scale * -0.02);
    ctx.bezierCurveTo(direction * scale * 0.55, scale * 0.3, direction * scale * -0.04, scale * 0.34 * wobble, direction * scale * -0.32, 0);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = Math.max(scale * 0.025, 1.25);
    ctx.beginPath();
    ctx.moveTo(direction * scale * -0.12, scale * -0.09);
    ctx.bezierCurveTo(direction * scale * 0.08, scale * -0.18, direction * scale * 0.36, scale * -0.16, direction * scale * 0.52, scale * -0.04);
    ctx.stroke();

    ctx.restore();
}

function drawCurvedHalf(direction, scale, progress, options) {
    const totalSegments = 42;
    const visibleSegments = Math.max(1, Math.ceil(totalSegments * progress));
    const points = [];

    for (let index = 0; index <= totalSegments; index++) {
        const t = index / totalSegments;
        const x = direction * scale * (0.09 + options.length * t);
        const y = scale * (
            options.lift +
            (options.droop * t * t) -
            (Math.sin(t * Math.PI) * options.wave)
        );
        points.push({ x, y });
    }

    ctx.strokeStyle = '#0d0b0a';
    ctx.lineWidth = Math.max(scale * options.width, 2.5);
    strokeVisiblePoints(points, visibleSegments);

    if (options.highlight !== false && options.width > 0.08) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = Math.max(scale * 0.028, 1.25);
        strokeVisiblePoints(points.map((point) => ({ x: point.x, y: point.y - scale * options.width * 0.23 })), visibleSegments);
    }

    if (options.curl && progress > 0.78) {
        drawTipCurl(direction, points[points.length - 1], scale, options.curl, options.curlOffset || 0, (progress - 0.78) / 0.22);
    }
}

function strokeVisiblePoints(points, visibleSegments) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let index = 1; index <= visibleSegments; index++) {
        const point = points[index];
        const previous = points[index - 1];
        const controlX = (previous.x + point.x) / 2;
        const controlY = previous.y + Math.sin(index * 1.7) * 0.9;
        ctx.quadraticCurveTo(controlX, controlY, point.x, point.y);
    }

    ctx.stroke();
}

function drawTipCurl(direction, tip, scale, radiusScale, offsetY, progress) {
    const curlProgress = clamp(progress, 0, 1);
    const radius = scale * radiusScale;
    const centerX = tip.x - direction * radius * 0.15;
    const centerY = tip.y + scale * offsetY;

    ctx.strokeStyle = '#0d0b0a';
    ctx.lineWidth = Math.max(scale * 0.065, 3.5);
    ctx.beginPath();
    ctx.arc(
        centerX,
        centerY,
        radius,
        direction > 0 ? 0.22 : Math.PI - 0.22,
        direction > 0 ? 0.22 - Math.PI * curlProgress : Math.PI - 0.22 + Math.PI * curlProgress,
        direction > 0
    );
    ctx.stroke();
}

function drawCenterKnot(scale, progress, width = 0.16, height = 0.1) {
    const centerProgress = Math.min(Math.max((progress - 0.68) / 0.32, 0), 1);
    if (centerProgress === 0) {
        return;
    }

    ctx.save();
    ctx.globalAlpha = centerProgress;
    ctx.fillStyle = '#15110f';
    ctx.beginPath();
    ctx.ellipse(0, scale * 0.01, scale * width, scale * height, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function pointFromLandmark(landmark, width, height) {
    if (!landmark) {
        return null;
    }

    return {
        x: landmark.x * width,
        y: landmark.y * height
    };
}

function cubicPoint(start, control1, control2, end, t) {
    const inverse = 1 - t;
    const inverseSquared = inverse * inverse;
    const tSquared = t * t;

    return {
        x: (inverseSquared * inverse * start.x) +
            (3 * inverseSquared * t * control1.x) +
            (3 * inverse * tSquared * control2.x) +
            (tSquared * t * end.x),
        y: (inverseSquared * inverse * start.y) +
            (3 * inverseSquared * t * control1.y) +
            (3 * inverse * tSquared * control2.y) +
            (tSquared * t * end.y)
    };
}

function midpoint(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
    };
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function easeInOutCubic(value) {
    return value < 0.5
        ? 4 * value * value * value
        : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function debounce(callback, delay) {
    let timeoutId = 0;

    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => callback(...args), delay);
    };
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
}
