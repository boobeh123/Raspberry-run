/**************************************************************
DOM selectors
***************************************************************/
const canvas = document.querySelector('.gameCanvas');
const scoreAnnouncer = document.querySelector('.scoreAnnouncer');
const soundButton = document.querySelector('.soundButton');
const soundState = document.querySelector('.soundState');
const ctx = canvas.getContext('2d');

/**************************************************************
Settings
***************************************************************/
// The game is drawn on a fixed 900x300 stage and scaled to fit the page
const WIDTH = 900;
const HEIGHT = 300;
const GROUND_Y = 250;

const PLAYER_X = 110;
const PLAYER_RADIUS = 22;
const GRAVITY = 2200; // px per second squared
const JUMP_VELOCITY = -820; // px per second, upward
const SHORT_HOP_VELOCITY = -450; // letting go early cuts the jump to this; a quick tap still clears a chip

const BASE_SPEED = 320; // px per second at the starting temperature
const START_TEMP = 40;
const MIN_TEMP = 35;
const THROTTLE_TEMP = 85;
const HEAT_PER_SECOND = 0.9;
const SNOW_COOLING = 10;

const BEST_SCORE_KEY = 'raspberryRunBest';
const SOUND_OFF_KEY = 'raspberryRunSoundOff';

const COLOR_NAMES = [
  'gameSkyCool', 'gameSkyHot', 'gameBoard', 'gameTrace', 'gameBerry', 'gameBerryDark',
  'gameSeed', 'gameLeaf', 'gameChip', 'gamePin', 'gameSnow', 'gameInk',
  'gameTempOk', 'gameTempWarm', 'gameTempHot',
];

/**************************************************************
State
***************************************************************/
let colors = {};
let gameState = 'ready'; // ready | running | paused | over
let player;
let chips;
let snowflakes;
let temp;
let distance;
let groundOffset;
let nextChipIn;
let nextSnowIn;
let crashReason;
let bestScore = 0;
let lastFrameTime = 0;
let audioContext = null; // created on the first tap or key press; browsers block audio before that
let isSoundOn = true;

/**************************************************************
Helper functions
***************************************************************/
// Canvas can't use CSS variables directly, so read the design tokens once
const readColors = () => {
  const styles = getComputedStyle(document.documentElement);
  colors = Object.fromEntries(
    COLOR_NAMES.map((name) => [name, styles.getPropertyValue(`--${name}`).trim()])
  );
};

const randomBetween = (min, max) => min + Math.random() * (max - min);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Blend two #rrggbb colors; amount 0 = first color, 1 = second
const mixColors = (from, to, amount) => {
  const toRgb = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  const [r, g, b] = toRgb(from).map((channel, i) => Math.round(channel + (toRgb(to)[i] - channel) * amount));
  return `rgb(${r}, ${g}, ${b})`;
};

// Browser storage can be blocked (private windows, previews), so never let it break the game
const loadBestScore = () => {
  try {
    return Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
  } catch {
    return 0;
  }
};

const saveBestScore = (score) => {
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(score));
  } catch {
    // Best score just won't be remembered this time
  }
};

const loadSoundSetting = () => {
  try {
    return localStorage.getItem(SOUND_OFF_KEY) !== 'true';
  } catch {
    return true;
  }
};

const saveSoundSetting = (isOn) => {
  try {
    localStorage.setItem(SOUND_OFF_KEY, String(!isOn));
  } catch {
    // Setting just won't be remembered this time
  }
};

const getScore = () => Math.floor(distance / 10);

// Hotter CPU = faster game: double speed at the throttle temperature
const getSpeed = () => BASE_SPEED * (1 + (temp - START_TEMP) / (THROTTLE_TEMP - START_TEMP));

// Circle (the raspberry) against rectangle (a chip), with a little forgiveness
const hitsChip = (chip) => {
  const centerX = PLAYER_X;
  const centerY = player.y - PLAYER_RADIUS;
  const nearestX = clamp(centerX, chip.x, chip.x + chip.width);
  const nearestY = clamp(centerY, GROUND_Y - chip.height, GROUND_Y);
  const forgivingRadius = PLAYER_RADIUS * 0.8;
  return (centerX - nearestX) ** 2 + (centerY - nearestY) ** 2 < forgivingRadius ** 2;
};

const touchesSnowflake = (flake) => {
  const centerY = player.y - PLAYER_RADIUS;
  return (PLAYER_X - flake.x) ** 2 + (centerY - flake.y) ** 2 < (PLAYER_RADIUS + 14) ** 2;
};

// Match the canvas's pixel size to its on-screen size so it stays sharp on any screen
const resizeCanvas = () => {
  const scale = (canvas.clientWidth / WIDTH) * (window.devicePixelRatio || 1);
  canvas.width = Math.round(WIDTH * scale);
  canvas.height = Math.round(HEIGHT * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  draw();
};

/**************************************************************
Sound
***************************************************************/
// Every sound is a short synthesized tone, so there are no audio files to load
const playTone = ({ from, to = from, duration, wave = 'square', volume = 0.06, delay = 0 }) => {
  if (!isSoundOn || !audioContext) return;
  const start = audioContext.currentTime + delay;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(from, start);
  oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
  // Fade out instead of stopping dead, which would click
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
};

const SOUNDS = {
  jump: () => playTone({ from: 420, to: 700, duration: 0.12 }),
  snowflake: () => {
    playTone({ from: 1320, duration: 0.09, wave: 'sine', volume: 0.08 });
    playTone({ from: 1760, duration: 0.14, wave: 'sine', volume: 0.08, delay: 0.08 });
  },
  crash: () => playTone({ from: 220, to: 55, duration: 0.4, wave: 'sawtooth', volume: 0.07 }),
  throttle: () => [0, 0.18, 0.36].forEach((delay) => playTone({ from: 880, to: 660, duration: 0.14, delay })),
  newBest: () => [523, 659, 784, 1047].forEach((note, index) =>
    playTone({ from: note, duration: 0.12, wave: 'triangle', volume: 0.08, delay: 0.45 + index * 0.1 })
  ),
};

const unlockAudio = () => {
  if (audioContext) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) audioContext = new AudioContextClass();
};

// The label stays "Sound"; aria-pressed tells screen readers the state, and the on/off tag shows it visually
const updateSoundButton = () => {
  soundButton.setAttribute('aria-pressed', String(isSoundOn));
  soundState.textContent = isSoundOn ? 'on' : 'off';
};

/**************************************************************
Game logic
***************************************************************/
const resetGame = () => {
  player = { y: GROUND_Y, velocityY: 0, isOnGround: true, squash: 0 };
  chips = [];
  snowflakes = [];
  temp = START_TEMP;
  distance = 0;
  groundOffset = 0;
  nextChipIn = 500;
  nextSnowIn = 2;
  crashReason = '';
};

const startGame = () => {
  resetGame();
  gameState = 'running';
  scoreAnnouncer.textContent = '';
};

const endGame = (reason, soundName) => {
  gameState = 'over';
  crashReason = reason;
  SOUNDS[soundName]();
  const score = getScore();
  const isNewBest = score > bestScore;
  if (isNewBest) {
    bestScore = score;
    saveBestScore(score);
    SOUNDS.newBest();
  }
  scoreAnnouncer.textContent = `${reason} Score ${score}.${isNewBest ? ' New best!' : ''}`;
};

const jump = () => {
  if (!player.isOnGround) return;
  player.velocityY = JUMP_VELOCITY;
  player.isOnGround = false;
  SOUNDS.jump();
};

const spawnChip = () => {
  const width = randomBetween(34, 70);
  chips.push({ x: WIDTH + 20, width, height: randomBetween(30, 52) });
};

const spawnSnowflake = () => {
  snowflakes.push({ x: WIDTH + 20, y: GROUND_Y - randomBetween(80, 150), spin: 0 });
};

const update = (seconds) => {
  // The CPU heats up the longer you run
  temp = Math.max(MIN_TEMP, temp + HEAT_PER_SECOND * seconds);
  if (temp >= THROTTLE_TEMP) {
    endGame('Thermal throttled at 85 °C!', 'throttle');
    return;
  }

  const speed = getSpeed();
  const moved = speed * seconds;
  distance += moved;
  groundOffset = (groundOffset + moved) % 60;

  // Player physics
  player.velocityY += GRAVITY * seconds;
  player.y += player.velocityY * seconds;
  if (player.y >= GROUND_Y) {
    if (!player.isOnGround) player.squash = 1; // squish on landing
    player.y = GROUND_Y;
    player.velocityY = 0;
    player.isOnGround = true;
  }
  player.squash = Math.max(0, player.squash - seconds * 6);

  // Spawn chips by distance, so gaps stay jumpable at any speed
  nextChipIn -= moved;
  if (nextChipIn <= 0) {
    spawnChip();
    nextChipIn = randomBetween(380, 720) * Math.sqrt(speed / BASE_SPEED);
  }

  nextSnowIn -= seconds;
  if (nextSnowIn <= 0) {
    spawnSnowflake();
    nextSnowIn = randomBetween(2.5, 4.5);
  }

  chips.forEach((chip) => {
    chip.x -= moved;
  });
  snowflakes.forEach((flake) => {
    flake.x -= moved;
    flake.spin += seconds * 2;
  });

  const collected = snowflakes.filter(touchesSnowflake);
  temp = Math.max(MIN_TEMP, temp - collected.length * SNOW_COOLING);
  if (collected.length > 0) SOUNDS.snowflake();

  chips = chips.filter((chip) => chip.x + chip.width > -20);
  snowflakes = snowflakes.filter((flake) => flake.x > -20 && !collected.includes(flake));

  if (chips.some(hitsChip)) endGame('Crashed into a hot chip!', 'crash');
};

/**************************************************************
Drawing
***************************************************************/
const drawBackground = () => {
  const heat = clamp((temp - MIN_TEMP) / (THROTTLE_TEMP - MIN_TEMP), 0, 1);
  ctx.fillStyle = mixColors(colors.gameSkyCool, colors.gameSkyHot, heat);
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Circuit board ground with scrolling traces
  ctx.fillStyle = colors.gameBoard;
  ctx.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);
  ctx.strokeStyle = colors.gameTrace;
  ctx.lineWidth = 2;
  for (let x = -groundOffset; x < WIDTH + 60; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y + 14);
    ctx.lineTo(x + 24, GROUND_Y + 14);
    ctx.lineTo(x + 36, GROUND_Y + 30);
    ctx.lineTo(x + 60, GROUND_Y + 30);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 24, GROUND_Y + 14, 3, 0, Math.PI * 2);
    ctx.fillStyle = colors.gameTrace;
    ctx.fill();
  }
};

const drawPlayer = () => {
  const centerY = player.y - PLAYER_RADIUS;
  // Squash wide on landing, stretch tall while rising
  const stretch = player.isOnGround ? -player.squash * 0.25 : clamp(-player.velocityY / 4000, -0.1, 0.15);

  ctx.save();
  ctx.translate(PLAYER_X, centerY);
  ctx.scale(1 - stretch, 1 + stretch);

  // Leaves
  ctx.fillStyle = colors.gameLeaf;
  [-0.6, 0, 0.6].forEach((angle) => {
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, -PLAYER_RADIUS - 4, 5, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Berry
  ctx.fillStyle = colors.gameBerry;
  ctx.beginPath();
  ctx.arc(0, 0, PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = colors.gameBerryDark;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Seeds
  ctx.fillStyle = colors.gameSeed;
  [[-12, 8], [-4, 14], [6, 12], [13, 4], [-14, -4], [10, -10]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.ellipse(x, y, 1.6, 2.4, 0.3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Eyes: squeezed shut when the CPU is nearly throttling
  ctx.fillStyle = colors.gameInk;
  ctx.strokeStyle = colors.gameInk;
  if (temp > THROTTLE_TEMP - 10) {
    ctx.lineWidth = 2;
    [[0, -5], [11, -5]].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.moveTo(x - 3, y - 2);
      ctx.lineTo(x + 3, y);
      ctx.lineTo(x - 3, y + 2);
      ctx.stroke();
    });
  } else {
    [[0, -5], [11, -5]].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 2.8, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  ctx.restore();
};

const drawChip = (chip) => {
  const top = GROUND_Y - chip.height;
  const heat = clamp((temp - START_TEMP) / (THROTTLE_TEMP - START_TEMP), 0, 1);

  // Pins along both sides
  ctx.fillStyle = colors.gamePin;
  for (let y = top + 6; y < GROUND_Y - 4; y += 9) {
    ctx.fillRect(chip.x - 5, y, 5, 4);
    ctx.fillRect(chip.x + chip.width, y, 5, 4);
  }

  // Body, glowing hotter as the CPU heats up
  ctx.save();
  ctx.shadowColor = colors.gameTempHot;
  ctx.shadowBlur = 4 + heat * 16;
  ctx.fillStyle = colors.gameChip;
  ctx.fillRect(chip.x, top, chip.width, chip.height);
  ctx.restore();

  // Notch
  ctx.fillStyle = colors.gamePin;
  ctx.beginPath();
  ctx.arc(chip.x + 8, top + 8, 3, 0, Math.PI * 2);
  ctx.fill();
};

const drawSnowflake = (flake) => {
  ctx.save();
  ctx.translate(flake.x, flake.y);
  ctx.rotate(flake.spin);
  ctx.strokeStyle = colors.gameSnow;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let arm = 0; arm < 6; arm += 1) {
    ctx.rotate(Math.PI / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -13);
    ctx.moveTo(0, -8);
    ctx.lineTo(-4, -11);
    ctx.moveTo(0, -8);
    ctx.lineTo(4, -11);
    ctx.stroke();
  }
  ctx.restore();
};

const drawHud = () => {
  ctx.fillStyle = colors.gameInk;
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Score ${getScore()}`, 16, 14);
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillText(`Best ${bestScore}`, 16, 38);

  // Thermometer bar
  const barWidth = 170;
  const barX = WIDTH - barWidth - 16;
  const fill = clamp((temp - MIN_TEMP) / (THROTTLE_TEMP - MIN_TEMP), 0, 1);
  let barColor = colors.gameTempOk;
  if (temp >= 70) barColor = colors.gameTempHot;
  else if (temp >= 60) barColor = colors.gameTempWarm;

  ctx.textAlign = 'right';
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.fillText(`CPU ${temp.toFixed(0)} °C`, WIDTH - 16, 14);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.fillRect(barX, 40, barWidth, 10);
  ctx.fillStyle = barColor;
  ctx.fillRect(barX, 40, barWidth * fill, 10);
};

const drawOverlay = (title, lines) => {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = colors.gameInk;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 34px system-ui, sans-serif';
  ctx.fillText(title, WIDTH / 2, 100);
  ctx.font = '18px system-ui, sans-serif';
  lines.forEach((line, index) => ctx.fillText(line, WIDTH / 2, 150 + index * 30));
};

const draw = () => {
  if (!player) return;
  drawBackground();
  snowflakes.forEach(drawSnowflake);
  chips.forEach(drawChip);
  drawPlayer();
  drawHud();

  if (gameState === 'ready') {
    drawOverlay('Raspberry Run', [
      'Jump hot chips. Grab snowflakes to cool the CPU.',
      'Press Space or tap to start',
    ]);
  } else if (gameState === 'paused') {
    drawOverlay('Paused', ['Press Space or tap to keep running']);
  } else if (gameState === 'over') {
    drawOverlay(crashReason, [
      `Score ${getScore()}  ·  Best ${bestScore}`,
      'Press Space or tap to play again',
    ]);
  }
};

const frame = (now) => {
  // Cap the step so a slow frame or a background tab can't teleport through a chip
  const seconds = Math.min((now - lastFrameTime) / 1000, 1 / 30);
  lastFrameTime = now;
  if (gameState === 'running') update(seconds);
  draw();
  requestAnimationFrame(frame);
};

/**************************************************************
Input handlers
***************************************************************/
const handlePress = () => {
  unlockAudio();
  if (gameState === 'running') {
    jump();
  } else if (gameState === 'paused') {
    gameState = 'running';
  } else {
    startGame();
  }
};

// Letting go early turns a full jump into a short hop
const handleRelease = () => {
  if (player && player.velocityY < SHORT_HOP_VELOCITY) player.velocityY = SHORT_HOP_VELOCITY;
};

const isJumpKey = (event) => ['Space', 'ArrowUp', 'KeyW'].includes(event.code);

const handleKeyDown = (event) => {
  if (!isJumpKey(event)) return;
  // Space on a focused button should press the button, not jump
  if (event.target.closest('button')) return;
  event.preventDefault(); // Space would otherwise scroll the page
  if (event.repeat) return;
  handlePress();
};

const handleKeyUp = (event) => {
  if (isJumpKey(event)) handleRelease();
};

const handlePointerDown = (event) => {
  event.preventDefault();
  canvas.focus();
  handlePress();
};

const handleSoundToggle = () => {
  isSoundOn = !isSoundOn;
  saveSoundSetting(isSoundOn);
  updateSoundButton();
  unlockAudio();
};

const handleVisibilityChange = () => {
  if (document.hidden && gameState === 'running') gameState = 'paused';
};

/**************************************************************
Event listeners
***************************************************************/
document.addEventListener('keydown', handleKeyDown);
soundButton.addEventListener('click', handleSoundToggle);
document.addEventListener('keyup', handleKeyUp);
canvas.addEventListener('pointerdown', handlePointerDown);
canvas.addEventListener('pointerup', handleRelease);
canvas.addEventListener('pointercancel', handleRelease);
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('resize', resizeCanvas);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);

readColors();
bestScore = loadBestScore();
isSoundOn = loadSoundSetting();
updateSoundButton();
resetGame();
resizeCanvas();
requestAnimationFrame((now) => {
  lastFrameTime = now;
  frame(now);
});
