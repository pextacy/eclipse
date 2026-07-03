declare module "tweetnacl-sealedbox-js" {
  interface SealedBox {
    seal(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array;
    open(
      ciphertext: Uint8Array,
      recipientPublicKey: Uint8Array,
      recipientSecretKey: Uint8Array,
    ): Uint8Array | null;
    readonly overheadLength: number;
  }
  const sealedbox: SealedBox;
  export default sealedbox;
}
