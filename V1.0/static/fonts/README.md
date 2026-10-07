# Bundled Persian typefaces

These fonts are included locally so every Persian font choice works without an installed system font, a font CDN, or a third-party network request. TaskArcade serves them from its own static directory and includes them in its offline app cache. The CSS selects only the family configured in Settings; each selected face uses `font-display: swap` so text remains readable while it loads.

All included font files are unmodified upstream files. Each font is licensed under the SIL Open Font License, version 1.1 (OFL); the corresponding complete license and copyright notice are in `licenses/`.

| Family | Bundled files / weights | Upstream source and revision | License |
| --- | --- | --- | --- |
| Vazirmatn | Variable WOFF2, weights 100–900 | [rastikerdar/vazirmatn](https://github.com/rastikerdar/vazirmatn), `6e553e33489a8f9dfaccc76860a2e3f3c1e66de7` | `licenses/Vazirmatn-OFL.txt` |
| Estedad | Variable WOFF2, weights 100–900 | [aminabedi68/Estedad](https://github.com/aminabedi68/Estedad), `0dbe689787b8c2ea302373cb601d0f352f9f98e5` | `licenses/Estedad-OFL.txt` |
| Noto Naskh Arabic | Variable TrueType, weights 400–700 | [google/fonts, `ofl/notonaskharabic`](https://github.com/google/fonts/tree/7085eb89a950e85db5b166b7a58d414544b4140c/ofl/notonaskharabic); upstream source revision `59f5a3fd985bf24858915c3dddfc51a537640965` | `licenses/NotoNaskhArabic-OFL.txt` |
| Sahel | Static WOFF2 weights 300, 400, 600, 700, and 900 | [rastikerdar/sahel-font](https://github.com/rastikerdar/sahel-font), `81ea305068b028ce311807c574fef50f3d4e2c54` | `licenses/Sahel-OFL.txt` |

The Sahel static webfonts are used instead of its upstream variable build, whose maintainers document known mark-placement and Latin-coverage limitations. No font was modified or subsetted for TaskArcade.
