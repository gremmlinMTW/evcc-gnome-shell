# evcc Top Bar

A GNOME Shell extension that displays selected values from an evcc server and can open the evcc web interface in a separate window.

## Requirements

- GNOME 51 (45-50 might work but not tested). The extension uses the GJS, GTK 4, libadwaita, and libsoup runtime provided by GNOME.
- An evcc server reachable from the desktop. Configure its URL in the extension preferences.
- WebKitGTK 6.0 with its GJS introspection bindings to open the embedded web-app window. This is only needed for that window; panel polling and preferences do not use WebKitGTK. Install the distribution package that provides the `WebKit` 6.0 GJS namespace; package names vary by distribution.

## Connection security

When the evcc URL uses HTTP, traffic is not encrypted. Other devices on the network may read evcc data or intercept the Basic Auth credentials. Use HTTPS when available, or connect only over a trusted network. The preferences show a warning for HTTP URLs.

## License

Copyright (C) 2026 gremmlinMTW.

This extension is licensed under the GNU General Public License, version 2 or (at your option) any later version (SPDX: `GPL-2.0-or-later`). See [LICENSE](LICENSE) for the full terms.