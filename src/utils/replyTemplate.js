import { textToHtml } from '../components/RichTextEditor';

export function replyTemplateHtml(templateBody) {
  return textToHtml(typeof templateBody === 'string' ? templateBody : '');
}
