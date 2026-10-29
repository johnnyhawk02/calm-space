# Calm Space

A calm, tactile 3D sensory app for iPad, made for autistic and neurodivergent children. It has no goals, scores, timers, fail states, reading or sudden events. Every touch gets an immediate, gentle and consistent response.

It is a Progressive Web App: plain HTML and ES modules, no build step, with one dependency (Three.js r170, vendored). It works fully offline after the first load.

## The 10 scenes

| # | Scene | Touch | Sound |
|---|-------|-------|-------|
| 1 | Disc Field | Drag to push springy discs. They tilt, wobble, bump their neighbours and settle. | FM chimes. Pitch follows the column, volume follows push speed, and notes are rate-limited into a shimmer. |
| 2 | Jelly Blob | Poke to dent it, pinch with two fingers to squish it, touch beside it and it leans towards you. | Low "squish" tones, a soft bloop on release and a warm pad while pinching. |
| 3 | Star Swarm | Thousands of stars flock to each finger and swirl around it. Each finger has its own colour. Let go and they drift apart. | A shimmering pad that swells with the swarm's speed. |
| 4 | Ripple Pond | Tap or drag to make spreading rings. Hold still and a slow ring keeps pulsing. Lily pads and gems bob on the waves. | Water drops, pitched by position. |
| 5 | Squishy Clay | A soft ball of clay. Prod it to squish it, hold to press a dimple in, and drag to pull lumps out. Held shapes stay moulded. Turn it with the arrow buttons on the left (or drag around it), and the round button makes it a ball again. | Low squish tones, plus a warm pad that climbs the scale as you stretch it. Letting go gives a soft bloop. |
| 6 | Gravity Garden | Hold one finger to make a gravity well that gems spiral into. Hold two or more fingers to push them away. | Soft clinks when gems meet, plus a low hum from each well. |
| 7 | Chime Waterfall | Touch to drop a bead, hold to pour beads, drag sideways to tilt the board. | Each peg rings a note from its column (a music box). |
| 8 | Kaleidoscope | Paint shapes that are mirrored into 6 to 12 turning segments and fade over about 10 s. | Bells pitched by distance from the centre. |
| 9 | Squishy Mirror | The front camera's picture becomes soft jelly. Drag to pull and smear it, hold still to make a magnifying bulge, and let go to watch it wobble back. Without a camera it uses a soft colourful pattern. The button on the left switches between the front and back cameras. | Squish tones and a stretching pad, like the clay. |
| 10 | Bubble Cannon | The same camera picture, with a friendly cannon near the bottom and a big shiny red button beside it. Press the button and the cannon lobs a soft ball at the middle of the picture, landing a little off-centre each time. Hold the button to keep firing gently, about twice a second. Where a ball lands, the picture is pressed in and wobbles back out. Balls squash and fade, so nothing piles up. Touching the picture pulls and squishes it, as in Squishy Mirror. It has the same front/back camera switch. | A soft plip as a ball leaves the cannon, and a round squish tone when it lands. |

### Sound sliders

Each scene has **three large vertical sliders on the right-hand side** that change its sound, and every scene has its own set. Moving a slider plays a soft preview bell so the change is heard at once. Values are saved per scene. The panel dims after 4 s and wakes when touched. Parents can hide it in settings ("Show the 3 sound sliders on the right").

| Scene | Sliders (top to bottom) |
|-------|-------------------------|
| Disc Field | Echo · Shimmer · Pitch |
| Jelly Blob | Wobble · Warmth · Pitch |
| Star Swarm | Space · Echo · Sparkle |
| Ripple Pond | Echo · Space · Shimmer |
| Squishy Clay | Wobble · Echo · Pitch |
| Gravity Garden | Echo · Pitch · Sparkle |
| Chime Waterfall | Echo · Ring length · Pitch |
| Kaleidoscope | Echo · Shimmer · Space |
| Squishy Mirror | Wobble · Warmth · Pitch |
| Bubble Cannon | Wobble · Space · Pitch |

What each effect does:
- **Echo:** soft, darkening repeats. The spacing is set per scene, and feedback is capped at 0.6.
- **Space:** reverb amount.
- **Shimmer:** a slow chorus.
- **Warmth:** a low-pass filter, for a softer sound.
- **Sparkle:** a gentle +5 dB high shelf at most, plus brighter bells.
- **Wobble:** a slow 2.6 Hz tremolo.
- **Pitch:** moves every note by up to an octave, along the same pentatonic scale, so it always stays in tune.
- **Ring length:** how long bells ring, from 0.5× to 2.5×.

All effects sit before the compressor and limiter, so nothing can get loud or harsh.

Each scene has a gentle idle state, so it looks alive when nobody is touching it. The header of each scene file explains its physics and sound design.

## Run locally

You only need a static file server. For example:

```bash
cd calm-space
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` straight from disk (`file://`) will not work, because browsers block ES-module imports and service workers there.

To test on a real iPad on the same Wi-Fi, open `http://<your-computer-ip>:8080`. Sound and touch work over plain HTTP, but **installing to the home screen and offline mode need HTTPS** (see below).

## Deploy (HTTPS is required for install and offline use)

**GitHub Pages**
1. Push this folder to a GitHub repository, with the files at the repository root or in `/docs`.
2. Go to Settings › Pages › Build and deployment, choose "Deploy from a branch", then pick the branch and the folder.
3. Open `https://<user>.github.io/<repo>/`. All paths are relative, so a sub-path works.

**Netlify**
- Drag the `calm-space` folder onto https://app.netlify.com/drop, or connect the repository with no build command and `.` as the publish directory.

**Install on the iPad**
1. Open the HTTPS URL in **Safari**.
2. Tap Share › **Add to Home Screen**.
3. Launch it from the new icon. It opens full screen with no browser bar. Open it once while online so every file is cached; after that it works offline.

**Updating:** when you change any file, bump `VERSION` in `sw.js` (for example `calm-space-v2`) so installed copies fetch the new files.

## For parents

- **Tap to begin:** iPadOS only allows sound after a touch, so the app starts with a soft "tap to begin" screen.
- **No sound?** Check the iPad's silent/ring switch (or Control Centre silent mode) and the volume buttons. Silent mode can mute web audio.
- **Settings:** press and hold the small dot in the top-left corner for **3 seconds**. A ring fills as you hold, and a short tap does nothing, so children rarely open it by accident. You can change:
  - the theme: Pastel, Soft Neon Dark (the default) or High Contrast
  - master volume, a quiet ambient pad (off by default) and the musical scale (pentatonic major or minor)
  - motion speed and particle density (low, medium or high)
  - the number of kaleidoscope segments (6 to 12)
  - **Lock to this scene**, which hides the scene buttons
  - **Wind down**: after 5, 10, 15 or 20 minutes, the screen slowly dims and the sound quietens over 2 minutes, then stays calm and dim. It never stops suddenly.
- **Mute:** the speaker button in the top-right corner is always available.
- **Scene buttons:** the bar stays visible by default. To have it fade after 4 s, turn on "Auto-hide the scene buttons" in settings. Then a tap near the bottom edge brings it back.
- **Camera (Squishy Mirror and Bubble Cannon):** the camera is only switched on while one of those scenes is open. If the iPad has two cameras, a button on the left switches between the front and back camera, and the choice is remembered. iPadOS asks for permission the first time. The picture stays on the iPad: it is never recorded, saved or uploaded. If you refuse permission, the scene uses a colourful pattern instead.
- **Guided Access is the best way to keep a child inside the app.** Turn it on in Settings › Accessibility › Guided Access, open Calm Space, and triple-click the side (or Home) button. You can also disable areas of the screen, such as the settings dot.
- Settings and the last scene are saved on the device in localStorage.
- If the iPad has **Reduce Motion** turned on, every scene moves more slowly, camera drift is switched off, and there are fewer particles.

## Sensory-safety design

- Nothing flashes. Every animated glow or twinkle runs below 1 Hz, and scene changes fade through the theme's background colour, never through white.
- The camera never moves by itself, apart from a very slow drift in Disc Field and a slow turn in Jelly Blob, and both stop with Reduce Motion. There are no zooms or shakes.
- Audio runs through voice gain → master gain → compressor → limiter, plus a soft low-pass filter and reverb. At most 14 one-shot notes can play at once, and the oldest note fades out over about 40 ms when a new one needs its slot. Every envelope ramps up from silence (5 to 25 ms attack), so there are no clicks. Every scene also rate-limits its notes.
- Every pitch comes from one shared pentatonic scale, so any combination sounds pleasant.
- Layouts and random elements use a fixed seed, so a scene looks the same each visit (predictable).

## Project structure

```
index.html            app shell, CSS, nav, settings UI, splash (inline SVG icons)
manifest.webmanifest  PWA manifest
sw.js                 precaches every file; cache-first, works offline
js/main.js            renderer, render loop, adaptive pixel ratio, scene manager, settings, nav
js/input.js           unified Pointer Events multitouch (≤ 10 pointers: position, velocity, pressure)
js/audio.js           procedural Web Audio engine (chime, marimba, bubble, drop, squish, pads)
js/fxpanel.js         the three per-scene sound sliders on the right
js/util.js            themes, disposal, screen→world helpers, backdrop, rate limiter, on-screen button helpers
js/scenes/*.js        one file per scene (cannon.js builds on mirror.js's camera sheet)
vendor/three.module.js  Three.js r170 (minified ES-module build), served locally
icons/                apple-touch-icon (180), 192, 512 and a maskable 512
```

Every scene implements `init(renderer, audio, settings)`, `update(dt, time)`, `onPointerDown/Move/Up(pointer)`, `resize(w, h)` and `dispose()`, and exposes `scene` and `camera`.

## Testing that was done

The app was tested in headless Chromium (software WebGL) at iPad sizes 1180×820 and 820×1180, with multitouch simulated through Chrome DevTools touch events:
- All scenes load, respond to two-finger drags, taps and holds, and make sound, with **0 console errors** in both orientations, in all three themes, and with Reduce Motion on.
- **Memory:** after cycling through all scenes several times, GPU resources return to exactly the baseline (2 geometries, 0 textures, 2 programs, 0 audio pads). The JS heap levels off at about 6.2 to 6.4 MB, with roughly +0.05 MB per cycle by the end, which looks like JIT/cache warm-up rather than a leak.
- **Offline:** with the network turned off, the app reloads and all scenes load from the service-worker cache.
- **CPU cost per frame** (`update()` with two fingers down, desktop CPU): 0.6 ms at most (Star Swarm), and under 0.4 ms for every other scene. That leaves plenty of headroom inside the 16.7 ms frame budget on an A13 iPad.
- The settings hold (stays closed at 1.5 s, opens at 3 s, a short tap does nothing), nav auto-hide and bottom-edge reveal, and settings persistence were all checked.

## Decisions made

- **Cross-fade:** only one scene ever runs, so a true two-scene cross-fade was not possible. A switch fades a veil in the theme's background colour in (300 ms), disposes the old scene, builds the new one and fades the veil out (300 ms). That is about 600 ms in total, with no bright flash.
- **Star Swarm flocking:** the particles are drawn on the GPU (one `Points` draw call), but the boids simulation runs on the CPU with grid-binned alignment. This is about 0.6 ms for 3,000 stars, and it avoids float render targets, which are fragile on iOS. Cell-centroid cohesion and separation were tried and removed because they left visible grid lines. Instead, cohesion comes from the finger attractors and a smooth flow field.
- **Jelly Blob soft body:** the dents, wobble modes and squish are damped springs on the CPU, and the vertex shader turns them into a smooth surface with normals rebuilt per vertex. This is much cheaper than a per-vertex spring mesh and never tears.
- **No physics engine:** Gravity Garden (about 110 gems, O(n²) contacts) and Chime Waterfall (grid lookup of pegs) use small custom solvers.
- **Wind-down** never goes fully dark or silent. It settles at about 30% brightness and about 15% volume, so it never cuts off.
- **Mute** stays visible all the time, as the brief asks. It is a low-contrast button, and pressing it is harmless.
- **Ambient pad** is a quiet warm drone pitched per scene. It is off by default.
- **Default theme** is Soft Neon Dark: lower screen brightness, soft glows.
- **Idle sounds:** only Chime Waterfall makes sound when untouched (an occasional quiet bead about every 3 s, played at under half volume), because the gentle trickle is the point of that scene. Every other idle state is silent.
- **Touch pressure:** iPad finger touches don't report real pressure, so it is treated as medium. An Apple Pencil does deepen Jelly Blob dents.
- **Vendored Three.js** is the official minified ES-module build (about 690 KB), saved as `vendor/three.module.js` to keep the download small. Everything else is about 210 KB in total, icons included.
- **Sound sliders** are custom vertical sliders rather than `<input type=range>`. Vertical range inputs are unreliable in iPad Safari, and the custom version gives a 64 px wide touch target with a 34 px thumb. They are labelled with icons rather than text, and are keyboard and VoiceOver accessible (`role=slider`, arrow keys).
- **Squishy Clay** replaced Silk Ribbons, at Johnny's request. Each vertex has two layers of deformation: an elastic one (springs back with a wobble) and a plastic one (takes over while a finger holds, so shapes stay moulded). The moulded shape relaxes very slowly, with a half-life of about 3 minutes, so the clay never stays messy for good.
- **Bubble Cannon** reuses the Squishy Mirror sheet. A landing ball pulls the nearby picture towards the hit point, which looks like the picture being pressed in, and the springs then bounce it back out. Balls are slow, at most 12 are in the air, and there is no flash, bang or shake.
- **Front/back camera:** only the front camera is mirrored, because a mirrored back camera would make movement feel backwards. The switch is hidden on devices with a single camera.
- **Squishy Mirror** uses a 2D mass-spring sheet under the live camera picture, and the picture always springs back. A camera feed can't be moulded permanently without looking broken, so it never is. The camera is requested with `getUserMedia` only inside that scene, and stopped on leaving it.
- No dependencies were added beyond Three.js.

## Known limitations

- Frame rate was measured in software-rendered headless Chromium, which is not representative. Real 60 fps on an iPad 9th gen still needs confirming on the device. The app lowers the pixel ratio to 1.5 automatically if frames stay above 20 ms, and the Low density setting helps further.
- iOS cannot vibrate from the web, so there are no haptics.
- iOS may suspend audio when the app goes to the background. It resumes on return, or on the next touch.
- The service worker is cache-first, so remember to bump `VERSION` in `sw.js` when you deploy changes.
