# Code Signing Policy

## Overview

aitm uses code signing to ensure the integrity and authenticity of its release binaries. This document describes the signing practices for each supported platform.

## Windows

Windows binaries (`.exe` and `.msi` installers) are **not yet code-signed**. Code signing via the **[SignPath Foundation](https://signpath.org)** — a non-profit that provides free code signing for open-source projects — is planned for a future release. Until then, Windows SmartScreen / Defender may warn on first run ("Windows protected your PC" → **More info → Run anyway**).

Once signing is in place, the certificate will be issued in the name of SignPath Foundation and identify aitm as the signed software, with SignPath acting as a trusted intermediary between the project and the certificate authority.

**Artifacts to be signed (once enabled):**
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

**Windows** binaries are built via a GitHub Actions workflow that runs only on tagged releases. Code signing is not yet enabled; once SignPath signing is set up, signing requests will be submitted through SignPath.io and require manual approval by the maintainer before a certificate is applied.

**macOS** disk images are signed with the Developer ID certificate and notarized by Apple **locally by the maintainer** as part of the release process, then attached to the corresponding GitHub Release. There is no macOS CI workflow; macOS signing and notarization are performed on the maintainer's own machine.

## Verification

Every release on the [Releases page](https://github.com/kanfu-panda/aitm/releases) includes the platform binaries. Once Windows code signing is enabled, you can verify the signature using:

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
