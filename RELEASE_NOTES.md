# Dyntick 1.5.0

- Ready-to-run public container images for AMD64 and ARM64, built and security-checked on GitHub runners.
- A simpler Compose installation: download the image and start with `docker compose up -d`, with no server-side build, Alpine package downloads or dedicated builder configuration.
- Immutable numbered image releases and an automatically updated latest channel, with anonymous pull and startup verification.
- Runtime images contain only the compiled application, license and public runtime configuration.
- Readable application source, tests, dependency locks and build/release workflows in the official repository, with public source revision labels and signed image provenance.
- Source availability under PolyForm Noncommercial 1.0.0, allowing inspection and permitted noncommercial use while requiring separate permission for commercial use outside those terms.

# Dyntick 1.4.0

- An interactive oval cycle map that adapts to its card without internal scrolling, with up to six focus sessions and clear break markers.
- Stable, separated touch targets and consistent animated feedback across navigation, timer, settings, language and calendar controls.
- Stronger dark-mode cycle card contrast and fully visible navigation icons during hover animations.
- Softer page transitions with temporary blur, spring icon motion and reduced-motion support.
- Fuller Rubik numerals, optically centered clock punctuation and a centered timer status and sound row.
- An accessible soft language picker that preserves active and paused timers.
- An updated, digest-pinned official Nginx slim base and security-patched zlib shared by source and distribution builds, with vulnerability scans, gzip integrity and runtime checks on amd64 and arm64.

# Dyntick 1.3.0

- Separate Pomodoro, Activity and Settings pages with smooth directional sliding transitions.
- A cleaner timer face with animated digits and a subtle progress indicator.
- IBM Plex Sans throughout the interface, with rounded Nunito numerals exclusively for digits 0–9.
- Soft UI controls with inset hover and press feedback, contained keyboard focus and stronger dark-mode contrast.
- Refined outline icons with optical alignment and subtle hover animations.
- Page navigation with the left/right arrow keys or H/L, plus keyboard tips in Settings.
- Active timers, paused sessions and unsaved settings stay intact when changing pages.
- Updated welcome text and a student-made footer linking to the public GitHub repository.

# Dyntick 1.2.0

- German and Spanish translations for the timer, settings, study activity and accessibility labels.
- A compact language menu with saved preferences; English remains the initial language.
- Language changes preserve active timers, paused sessions and study history.
- A freestanding open-book mark with refined strokes and a matching transparent favicon.
- Mobile settings accommodate longer translated labels.

# Distribution update

- Compose follows the moving `latest` reference by default; no version edits are needed for updates.
- Re-run `docker compose up -d --build --wait` to install the newest stable release.
- Numbered releases and Compose attachments remain available for pinning and rollback.
- The private publisher automatically advances latest after a verified stable release.
- The application runtime is unchanged from 1.1.0.

# Dyntick 1.1.0

- Study activity calendar with annual heatmaps, year selection and daily session details.
- Today and weekly focus totals, stored locally and synchronized across browser tabs.
- Completed focus intervals are recorded once, including refresh and background recovery.
- Timer-first layout with compact navigation, a prominent primary action and a simpler cycle summary.
- English default and Italian localization; responsive light and dark themes.

# Dyntick 1.0.2

- The public distribution is now named `IlCandeDEV/dyntick`.
- Compose uses the new repository address; development history remains separate from the runtime distribution.
- The public README stays empty and the compiled application is unchanged from 1.0.1.

## Dyntick 1.0.1

- English by default, with an EN/IT language selector and saved preferences.
- Localized settings, dates, page titles and accessibility labels.
- Language changes preserve the current timer.
- A separate, history-free public distribution with an empty README and compiled runtime files only.
- A standalone Compose that prepares the Nginx container on the NAS without Deno, Node or registry credentials.

Place `compose.yaml` on the server, choose its host port and run `docker compose up -d`. Open `http://NAS_IP:8080` with the default port.
