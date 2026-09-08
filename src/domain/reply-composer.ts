/**
 * Composes the reply email content for both delivery mechanisms (AC-R5, UX brief §3).
 * Both lead with the sender's own `custom_message`, verbatim — never system boilerplate —
 * with subject and (attachment case) filename taken from `display_name`.
 */

export interface ComposableFile {
  display_name: string;
  custom_message: string | null;
}

export interface ComposedReply {
  subject: string;
  text: string;
  attachmentFilename?: string;
}

function subjectFor(file: ComposableFile): string {
  return `הקובץ שלך: ${file.display_name}`;
}

export const ReplyComposer = {
  /** Attachment case (≤ `ATTACH_LIMIT_BYTES`): body is the custom message, verbatim,
   * nothing appended (AC-R5). */
  forAttachment(file: ComposableFile): ComposedReply {
    return {
      subject: subjectFor(file),
      text: file.custom_message ?? '',
      attachmentFilename: file.display_name,
    };
  },

  /** Drive-share case: custom message verbatim, then the share link and the visitor-OTP
   * note (UX brief §3). */
  forDriveShare(file: ComposableFile, shareUrl: string): ComposedReply {
    const lines = [
      file.custom_message ?? '',
      '',
      'לפתיחת הקובץ, לחץ/י כאן:',
      shareUrl,
      '',
      '(אם אין לך חשבון Google, תוכל/י לאמת את עצמך',
      'באמצעות קוד חד-פעמי שיישלח למייל שלך.)',
    ];
    return { subject: subjectFor(file), text: lines.join('\n') };
  },
};
