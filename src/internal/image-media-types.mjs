/**
 * Media types this provider accepts from durable attachment references and
 * request-image projections.
 *
 * The Harness attachment store keeps a submitted image byte-identical only when
 * it already fits the normalized form; otherwise it re-encodes the image, and
 * the alpha rung of that ladder is WebP. A WebP reference is therefore an
 * ordinary Grok Build input, not an unsupported source.
 */
export const SUPPORTED_IMAGE_MEDIA_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
])

export function isSupportedImageMediaType(mediaType) {
  return SUPPORTED_IMAGE_MEDIA_TYPES.includes(mediaType)
}
