export interface FeedbackImage { name: string; mime_type: "image/png" | "image/jpeg" | "image/webp"; data: string }
export const MAX_IMAGES = 3;
export async function readFeedbackImages(files: File[], existingCount: number): Promise<FeedbackImage[]> {
  if (files.length + existingCount > MAX_IMAGES) throw new Error("最多上传 3 张图片，请移除后再添加");
  for (const file of files) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPG、WebP 图片");
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error("每张图片须大于 0 且不超过 5 MB");
  }
  return Promise.all(files.map(file => new Promise<FeedbackImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片「${file.name}」`));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.onload = () => resolve({ name: file.name.slice(0, 255), mime_type: file.type as FeedbackImage["mime_type"], data: String(reader.result).split(",")[1] });
    reader.readAsDataURL(file);
  })));
}
export function imageSource(image: FeedbackImage) { return `data:${image.mime_type};base64,${image.data}`; }
