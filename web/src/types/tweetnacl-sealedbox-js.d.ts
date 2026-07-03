declare module "tweetnacl-sealedbox-js" {
  const s: {
    seal(m: Uint8Array, pk: Uint8Array): Uint8Array;
    open(c: Uint8Array, pk: Uint8Array, sk: Uint8Array): Uint8Array | null;
  };
  export default s;
}
