import { describe, expect, it } from 'vitest';
import { ReplyComposer } from '../../src/domain/reply-composer.js';

describe('ReplyComposer (AC-R5)', () => {
  it('attachment case: body is the custom message verbatim, subject/filename use display_name', () => {
    const file = { display_name: 'תקציב 2026.xlsx', custom_message: 'הנה הקובץ שביקשת, תיהני!' };
    const reply = ReplyComposer.forAttachment(file);

    expect(reply.subject).toBe('הקובץ שלך: תקציב 2026.xlsx');
    expect(reply.text).toBe('הנה הקובץ שביקשת, תיהני!');
    expect(reply.attachmentFilename).toBe('תקציב 2026.xlsx');
  });

  it('attachment case with no custom message: body is an empty string, not "undefined" or "null"', () => {
    const reply = ReplyComposer.forAttachment({ display_name: 'x.pdf', custom_message: null });
    expect(reply.text).toBe('');
  });

  it('drive-share case: leads with the custom message verbatim, then the link and OTP note', () => {
    const file = { display_name: 'video.mp4', custom_message: 'זה סרטון החתונה' };
    const reply = ReplyComposer.forDriveShare(file, 'https://drive.google.com/file/d/abc123/view');

    expect(reply.subject).toBe('הקובץ שלך: video.mp4');
    expect(reply.text.startsWith('זה סרטון החתונה')).toBe(true);
    expect(reply.text).toContain('https://drive.google.com/file/d/abc123/view');
    expect(reply.text).toContain('לפתיחת הקובץ');
    expect(reply.text).toContain('קוד חד-פעמי');
    expect(reply.attachmentFilename).toBeUndefined();
  });
});
