/** Verifies that a webhook really came from the payment provider. Checked against the raw, unparsed body. */
export interface WebhookSignatureVerifier {
  isValid(rawBody: string, signature: string | undefined): boolean;
}
