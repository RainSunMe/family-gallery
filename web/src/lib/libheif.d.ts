// libheif-js ships no types for its pre-bundled ESM entry. Only the members this
// app uses are declared, so a change in the package surface fails loudly here.
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  type HeifImage = {
    get_width(): number;
    get_height(): number;
    display(data: ImageData, done: (result?: ImageData) => void): void;
  };
  type HeifModule = {
    HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
  };
  const factory: () => HeifModule;
  export default factory;
}
