# Bubble Rhythm (Deterministic)

Static, browser-based rhythm/timing bubble game inspired by osu!.
- Deterministic scripted patterns (no randomness)
- Multiple simultaneous bubbles ("chords")
- Input: mouse click OR press `E` (click-at-cursor)
- Overlap rule: bubble under cursor with smallest timing error is selected

## Run locally
Open `index.html` in a browser.

## Deploy on GitHub Pages
1. Create a new GitHub repo.
2. Add these files to the repo root:
   - `index.html`
   - `style.css`
   - `main.js`
3. Push to GitHub.
4. Repo → **Settings** → **Pages**:
   - Source: `Deploy from a branch`
   - Branch: `main` (or `master`) / `/root`
5. Save. Your site will appear at the Pages URL.

## Edit the chart / patterns
Open `main.js` and edit `buildBeatmap()`:
- Each note is `{ tMs, xN, yN }` with normalized 0..1 coordinates.
- You can add chords by pushing multiple notes with the same `tMs`.
