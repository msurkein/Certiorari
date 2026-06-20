# build/ resources

electron-builder auto-discovers files here.

## App icon (`icon.ico`)

The build works **without** an icon (falls back to the default Electron icon),
but for distribution you'll want a branded one.

1. `icon.svg` here is the source art (matches the in-app brand mark).
2. Convert it to a multi-resolution `icon.ico` (must include a 256×256 layer).
   Any of these work:
   - Online: an SVG→ICO converter, export at 256/128/64/48/32/16.
   - Local, one-off:
     ```sh
     npm i -D sharp png-to-ico
     node -e "const sharp=require('sharp'),toIco=require('png-to-ico');sharp('build/icon.svg').resize(256,256).png().toBuffer().then(b=>toIco([b])).then(b=>require('fs').writeFileSync('build/icon.ico',b))"
     ```
3. Drop the result at `build/icon.ico`. It's picked up automatically on the next
   `npm run dist`.
