# Raspberry Run

**Play it: https://raspberry-run.netlify.app**

A tiny endless runner made on a Raspberry Pi 5. You're a raspberry running across a circuit board. Jump the hot CPU chips, but watch the temperature: the CPU heats up the longer you run, and the game speeds up with it. Grab snowflakes to cool down. Hit 85 °C and you're thermal throttled.

## Play

Open `index.html` through any static server, for example:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

- **Space**, **↑**, **W**, or **tap** to jump. Hold for a higher jump; a quick tap still clears a chip.
- **P** or **Esc** pauses (there's also a Pause button for phones), and the game pauses by itself if you switch tabs.
- After a crash, presses are ignored for 0.6 seconds, so mashing jump doesn't skip past your score.
- Your best score is saved in the browser.
- Sound effects (jump, snowflake, crash, throttle alarm, new best) are synthesized with the Web Audio API, so there are no audio files. The **Sound** button turns them off and remembers your choice.

## How it works

Plain HTML, CSS, and canvas JavaScript, with no libraries and no build step.

- **Speed is tied to temperature.** The CPU gains 0.9 °C per second; speed scales from 1× at 40 °C to 2× at 85 °C. Each snowflake takes off 10 °C.
- **Chips spawn by distance, not time**, so the gaps stay jumpable as the game speeds up.
- **The frame step is capped** at 1/30 s, so a slow frame can't teleport the raspberry through a chip.
- **Canvas colors come from CSS custom properties** in `styles.css`, so all the design tokens live in one place.
- **Collision** checks the raspberry as a circle against each chip's rectangle, with a 20% forgiveness margin.

## Tested

Playtested in headless Chromium with a small bot pressing real Space keys: it survived 25-second runs four times in a row (scores ~900), both endings (crash and thermal throttle) and best-score saving worked, and there were no console errors.

## Deploying

Live on Netlify at https://raspberry-run.netlify.app. It's a static site: publish directory is the project root, no build command.
