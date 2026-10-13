# Third-party notices

LoongCode is licensed under the [Apache License 2.0](LICENSE). It bundles and
derives from third-party material that retains its own copyright and license
notices. Those notices are reproduced below and must be preserved in any
redistribution.

## Derived source code

Parts of `packages/tui` are ports or adaptations of third-party source. Each
file retains its upstream copyright header where the license requires it.

| Where | Upstream | License |
| --- | --- | --- |
| `packages/tui` | Mario Zechner | MIT |
| `packages/tui/src/oklab.ts` | Björn Ottosson (https://bottosson.github.io/posts/colorpicker/) | MIT |
| `packages/tui/src/stdin-buffer.ts` | OpenTUI (https://github.com/anomalyco/opentui) | MIT |
| `packages/tui/src/keys.ts` | opentui (https://github.com/sst/opentui) | MIT |
| `packages/tui/src/utils.ts` | string-width (Sindre Sorhus) | MIT |

## Bundled dependencies

The published `@loonglab/loongcode-cli` package bundles the following runtime
dependencies:

| Package | License | Copyright |
| --- | --- | --- |
| `get-east-asian-width` | MIT | Sindre Sorhus |
| `marked` | MIT | Christopher Jeffrey |
| `zod` | MIT | Colin McDonnell |
| `diff` | BSD-3-Clause | Kevin Decker |
| `ai` | Apache-2.0 | Vercel, Inc. |
| `@ai-sdk/openai` | Apache-2.0 | Vercel, Inc. |
| `@ai-sdk/anthropic` | Apache-2.0 | Vercel, Inc. |

## MIT License

Applies to the MIT-licensed entries above. Each copyright holder is named in its
row or in the source header.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## BSD 3-Clause License

Applies to `diff`. Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>.

```
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Apache License 2.0

Applies to `ai`, `@ai-sdk/openai`, and `@ai-sdk/anthropic` (Copyright 2023
Vercel, Inc.). The full license text is available at
<https://www.apache.org/licenses/LICENSE-2.0>.
