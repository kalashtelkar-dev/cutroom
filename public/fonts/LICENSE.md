# The subtitle fonts

Burned-in captions are drawn by libass inside the render container, and that
container carries one font, DejaVu, which has no glyph for any of the scripts
below. So the font travels with the subtitles: `lib/subtitles/fonts.ts` picks
the one the words need, the export uploads it, and the compiler muxes it into
the caption file as an attachment. See `AGENTS.md` for why it also has to be
named in the burn's style.

Every file here is Noto, under the SIL Open Font License 1.1, unmodified from
its upstream build. The copyright lines are read out of each font's own name
table rather than typed in.

| file | copyright |
|---|---|
| `NotoSansBengali.ttf` | Copyright 2025 The Noto Project Authors (https://github.com/notofonts/bengali) |
| `NotoSansDevanagari.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari) |
| `NotoSansEthiopic.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/ethiopic) |
| `NotoSansGujarati.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gujarati) |
| `NotoSansGurmukhi.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gurmukhi) |
| `NotoSansJP.otf` | © 2014-2021 Adobe (http://www.adobe.com/). |
| `NotoSansKR.otf` | © 2014-2021 Adobe (http://www.adobe.com/). |
| `NotoSansKannada.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/kannada) |
| `NotoSansKhmer.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/khmer) |
| `NotoSansLao.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/lao) |
| `NotoSansMalayalam.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/malayalam) |
| `NotoSansMyanmar.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/myanmar) |
| `NotoSansOriya.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/oriya) |
| `NotoSansSC.otf` | © 2014-2021 Adobe (http://www.adobe.com/). |
| `NotoSansSinhala.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/sinhala) |
| `NotoSansTamil.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tamil) |
| `NotoSansTelugu.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/telugu) |
| `NotoSansThai.ttf` | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thai) |

The Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
Malayalam, Sinhala, Thai, Lao, Khmer, Myanmar and Ethiopic files are the
variable fonts from `github.com/google/fonts`, whose default instance is
Regular. The three CJK files are the static Regular subsets from
`github.com/notofonts/noto-cjk`: the variable CJK fonts default to Thin,
which is not a weight to read subtitles in.

The full text of the licence they are all under follows.

Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
