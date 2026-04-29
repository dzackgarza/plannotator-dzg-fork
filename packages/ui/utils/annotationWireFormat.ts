import { Annotation, AnnotationType, type ImageAttachment } from "../types";

type StoredImage = string | [string, string];

export type StoredAnnotation =
  | ["D", string, string | null, StoredImage[]?]
  | ["R", string, string, string | null, StoredImage[]?]
  | ["C", string, string, string | null, StoredImage[]?, 1?]
  | ["I", string, string, string | null, StoredImage[]?]
  | ["G", string, string | null, StoredImage[]?];

export function parseStoredImages(
  raw: StoredImage[] | undefined,
): ImageAttachment[] | undefined {
  if (!raw?.length) return undefined;

  return raw.map((image) => {
    if (typeof image === "string") {
      const name = image.split("/").pop()?.replace(/\.[^.]+$/, "") || "image";
      return { path: image, name };
    }

    return { path: image[0], name: image[1] };
  });
}

export function toStoredImages(
  images: ImageAttachment[] | undefined,
): StoredImage[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => [image.path, image.name]);
}

export function toStoredAnnotations(
  annotations: Annotation[],
): StoredAnnotation[] {
  return annotations.map((annotation) => {
    const author = annotation.author || null;
    const images = toStoredImages(annotation.images);

    if (annotation.type === AnnotationType.GLOBAL_COMMENT) {
      return ["G", annotation.text || "", author, images];
    }

    const type = annotation.type[0] as "D" | "R" | "C" | "I";
    if (type === "D") {
      return ["D", annotation.originalText, author, images];
    }

    if (type === "C" && annotation.isQuickLabel) {
      return [
        "C",
        annotation.originalText,
        annotation.text || "",
        author,
        images ?? undefined,
        1,
      ];
    }

    return [type, annotation.originalText, annotation.text || "", author, images];
  });
}

export function fromStoredAnnotations(data: StoredAnnotation[]): Annotation[] {
  const typeMap: Record<string, AnnotationType> = {
    D: AnnotationType.DELETION,
    R: AnnotationType.REPLACEMENT,
    C: AnnotationType.COMMENT,
    I: AnnotationType.INSERTION,
    G: AnnotationType.GLOBAL_COMMENT,
  };

  return data.map((item, index) => {
    const type = item[0];

    if (type === "G") {
      const text = item[1] as string;
      const author = item[2] as string | null;
      const rawImages = item[3] as StoredImage[] | undefined;

      return {
        id: `restored-${index}-${Date.now()}`,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.GLOBAL_COMMENT,
        text: text || undefined,
        originalText: "",
        createdA: Date.now() + index,
        author: author || undefined,
        images: parseStoredImages(rawImages),
      };
    }

    const originalText = item[1];
    const text = type === "D" ? undefined : (item[2] as string);
    const author =
      type === "D" ? (item[2] as string | null) : (item[3] as string | null);
    const rawImages =
      type === "D"
        ? (item[3] as StoredImage[] | undefined)
        : (item[4] as StoredImage[] | undefined);
    const isQuickLabel =
      type === "C" && item.length > 5 && item[5] === 1 ? true : undefined;

    return {
      id: `restored-${index}-${Date.now()}`,
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: typeMap[type],
      text: text || undefined,
      originalText,
      createdA: Date.now() + index,
      author: author || undefined,
      images: parseStoredImages(rawImages),
      ...(isQuickLabel ? { isQuickLabel } : {}),
    };
  });
}
