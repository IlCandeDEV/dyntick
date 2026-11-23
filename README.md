# Dyntick

A simple yet functional space to study.

Dyntick is a student-made study full dashboard with a Pomodoro timer and an activity tracker.

## Why

The project started from personal needs and exlopration of html/typescript language.

At some point I thought that maybe other people would take advantage of this tool to stay productive.

## Preview

![Dyntick 2.0.0 main page in the light theme](docs/screenshots/pomodoro-v2.0.0-light.png)

*Light theme · Dyntick 2.0.0.*

![Dyntick 2.0.0 main page in the dark theme](docs/screenshots/pomodoro-v2.0.0-dark.png)

*Dark theme · Dyntick 2.0.0.*



## Features

POMODORO TIMER: 
- Default 25-minute focus, 5-minute short break and 15-minute long break after four focus sessions.
- Configurable duration for focus and breaks.
- Sound alarm for timer.
- Study cycle map to better manage study session
- Stats for every session.

ACTIVITY:
- Activity tracker for session
- GitHub style calendar visualization

PLANNING:
- Exam planning and subdivision for each session/semester
- Automatic course credit calculation

SYNC:
- Sync data across all devices.

LANGUAGE:
- English (default)
- Italian (best)
- German
- Spanish

THEMES:
- System, light and dark themes

ACCESSIBILITY:
- Reduced motion support for ADHD people like me
- Reset settings to default
- Keyboard controls for faster switch between tabs (vim style)







## Install

Here's a step by step guide to install and use Dyntick.

### STEP 1

*Prerequisites*

Install docker on your machine.
> MACOS: https://docs.docker.com/desktop/setup/install/mac-install/

> LINUX: https://docs.docker.com/engine/install/

> WINDOWS: https://docs.docker.com/desktop/setup/install/windows-install/


### STEP 2

Copy [compose.yaml](compose.yaml) into an empty folder on your server/homelab/pc and run:

```sh
docker compose up -d
```



### STEP 3

Open `http://SERVER_IP:8080`. Docker automatically pulls the ready-to-run public image.

To use a custom port, change the Compose port mapping to:

```yaml
ports:
  - "CUSTOM_PORT:8080"
```

Replace `CUSTOM_PORT` with the port you want to use, then open `http://SERVER_IP:CUSTOM_PORT`.





## Upgrade from Dyntick 1.x

**IF YOU ARE UPDATING FROM 1.x replace your old Compose file before starting version 2.0.0.** The 1.x Compose has a read-only filesystem and no database volume. Updating its image alone does not provide the persistent storage required by 2.0.0.

1. Keep a copy of your current Compose and replace it with the [new Compose](compose.yaml).
2. Keep the same project folder and your chosen host port, such as `"8090:8080"`.
3. Run `docker compose up -d --wait`.
4. Refresh Dyntick first in the original browser tab that holds the preferences and current timer you want to keep. Use the same address, protocol and port as before so that it can read its old browser storage.
5. Open the other browsers or devices that hold older study history to merge those records into the database.

Browser storage is tied to its original address. If the address or port has already changed, reopen the old address with the new application to import that browser's data. Dyntick cannot recover browser data that has been cleared or read storage from another device remotely.




## Your data and devices

Dyntick is made upon the privacy-first and local-first principle.
Personally I want my data private, without the need to rely on other people closed-source services. 



## Updating & versions

The default Compose follows the latest stable image. To update:

```sh
docker compose up -d --build --wait
```

The `--wait` option waits until the container is healthy. Updates happen when you run Compose; there is no background updater. Unchanged image layers are reused.

For a specific release:

```sh
DYNTICK_VERSION=2.0.0 docker compose up -d --build --wait
```


Stop Dyntick with:

```sh
docker compose down
```


## Back up the database

From the Compose folder, stop the service before copying its data, then start it again:

```sh
docker compose stop -t 30
docker compose cp dyntick:/data/. ./dyntick-backup
docker compose start
```

Use a new backup folder for each backup. Keep the complete copied folder, including any SQLite `-wal` or `-shm` files that are present, and store another copy outside the server.

To restore, keep Dyntick stopped while replacing its database files in the data volume. Restore a matching set of files; remove stale `-wal` and `-shm` files from the database being replaced. Preserve ownership `1000:1000` and restrictive file permissions so that the Bun user can access the restored data. Start the service only after the files and permissions are in place.



## Project inspect

| Area | Source |
| --- | --- |
| Main interface and navigation | [src/App.tsx](src/App.tsx), [src/StudyPages.tsx](src/StudyPages.tsx) |
| Shared client state and timer logic | [src/usePomodoro.ts](src/usePomodoro.ts), [src/timer.ts](src/timer.ts), [src/protocol.ts](src/protocol.ts) |
| Bun HTTP API and SQLite persistence | [server/app.ts](server/app.ts), [server/db.ts](server/db.ts), [server/index.ts](server/index.ts) |
| Legacy data import and activity records | [src/storage.ts](src/storage.ts), [src/activity.ts](src/activity.ts) |
| Locally generated sound | [src/audio.ts](src/audio.ts) |
| Translations | [src/i18n.ts](src/i18n.ts) |
| Container and persistent volume | [Dockerfile](Dockerfile), [compose.yaml](compose.yaml) |
| Dependency versions and lockfile | [package.json](package.json), [bun.lock](bun.lock) |
| Tests and build/release automation | [tests](tests), [.github/workflows](.github/workflows) |


Dyntick uses:
- TypeScript
- React 19
- Vite
- Astryx interface
- Bun
- SQLite


## License


Dyntick's application code, documentation and build scripts use the [PolyForm Noncommercial License 1.0.0](LICENSE). You can inspect the code and use, modify and redistribute it for the purposes permitted by that license, including personal study and qualifying noncommercial uses. Commercial use outside those permitted purposes requires separate permission from the copyright holder.

This is a **source-available, noncommercial project**. It is not offered under an OSI-approved open-source license. Dependencies and fonts retain their own licenses; the application license does not replace their terms. Font notices are included in [public/fonts](public/fonts).

### Commercial distribution

The following commercial distribution term is planned for future releases. Each published release is governed by the license shipped with it.

> Selling, reselling, charging for access to, or distributing Dyntick for commercial purposes requires prior written permission from the copyright holder. This restriction applies to both original and modified copies.


© 2026-2026 IlCandeDEV
