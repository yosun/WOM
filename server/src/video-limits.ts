// Shared by the video editor and the acceptance boundary. AI3D's H3 Max guide limits the
// prompt to 16,000 Unicode characters and the whole model input to 16 KiB of JSON.
// https://api.ai3d.dev/v2/models/h3-max-image-to-video/llm.txt
export const MAX_SLIDE_TITLE_CHARS = 120;
export const MAX_VIDEO_PROMPT_CHARS = 16_000;
export const MAX_VIDEO_INPUT_BYTES = 16 * 1024;

export const characterCount = (value: string) => [...value].length;
export const videoInput = (prompt: string) => ({ prompt, duration: 5, resolution: '768P', sync_mode: false, prompt_expansion_mode: 'balanced' });

// AI3D validates its input using Python's default json.dumps: non-ASCII UTF-16 units become
// \uXXXX escapes and it includes a space after every object colon and comma. The input is a
// flat object, so its separator overhead is 2 * field count - 1 bytes.
export function videoInputBytes(prompt: string): number {
  const input = videoInput(prompt);
  const ascii = JSON.stringify(input).replace(/[\u007f-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return ascii.length + Object.keys(input).length * 2 - 1;
}
export function videoPromptTooLong(prompt: string): boolean {
  return characterCount(prompt) > MAX_VIDEO_PROMPT_CHARS || videoInputBytes(prompt) > MAX_VIDEO_INPUT_BYTES;
}
