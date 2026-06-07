# Code Signing Policy

## Overview

aitm uses code signing to ensure the integrity and authenticity of its release binaries. This document describes the signing practices for each supported platform.

## Windows

Windows binaries (`.exe` and `.msi` installers) are signed using a certificate provided by the **[SignPath Foundation](https://signpath.org)** — a non-profit organization that provides free code signing for open-source projects.

The certificate is issued in the name of SignPath Foundation and identifies aitm as the signed software. SignPath Foundation acts as a trusted intermediary between the project and the certificate authority.

**Signed artifacts:**
- `aitm_<version>_x64_en-US.msi`
- `aitm_<version>_x64-setup.exe`
- `aitm_<version>_arm64_en-US.msi`
- `aitm_<version>_arm64-setup.exe`

## macOS

macOS disk images (`.dmg`) are signed with an **Apple Developer ID** certificate and notarized by Apple. Users can verify this by running:

```bash
spctl -a -t open --context context:primary-signature -v aitm_<version>_aarch64.dmg
# Expected: accepted  source=Notarized Developer ID
```

## Signing Process

All release builds are produced via GitHub Actions workflows in this repository. The signing process is automated and tied to tagged releases only — no ad-hoc signing occurs outside of the official release pipeline.

Signing requests for Windows are submitted through SignPath.io and require manual approval by the project maintainer before a certificate is applied.

## Verification

Every release on the [Releases page](https://github.com/kanfu-panda/aitm/releases) includes the signed binaries. You can verify the Windows code signature using:

```powershell
# Windows PowerShell
Get-AuthenticodeSignature .\aitm_<version>_x64_en-US.msi | Select-Object Status, SignerCertificate
```

## Roles

| Role | Responsibility |
|---|---|
| Author / Maintainer | kanfu-panda — owns the repository, submits signing requests |
| Approver | kanfu-panda — reviews and approves each signing request in SignPath |

## Contact

For questions about code signing or to report concerns, open an issue at https://github.com/kanfu-panda/aitm/issues or contact the maintainer via GitHub.
