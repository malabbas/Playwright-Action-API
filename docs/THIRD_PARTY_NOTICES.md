# Third-party notices

## Playwright Docker seccomp profile

The repository's `seccomp_profile.json` is copied from the Playwright project at version **v1.58.1**:

- Source: [microsoft/playwright — utils/docker/seccomp_profile.json](https://github.com/microsoft/playwright/blob/v1.58.1/utils/docker/seccomp_profile.json)
- Project: [Microsoft Playwright](https://github.com/microsoft/playwright)
- Upstream license: [Apache License, Version 2.0](licenses/Apache-2.0.txt)

Playwright is copyright Microsoft Corporation. The upstream profile extends Docker's default seccomp policy to permit the user-namespace operations required by Chromium's sandbox. This repository uses it for the Docker Compose browser runtime.

This attribution describes the copied third-party file. It does not select an overall license for the portfolio project's original source. Other installed dependencies retain their own package licenses.
