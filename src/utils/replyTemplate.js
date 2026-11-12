import { textToHtml } from './textToHtml';

export function replyTemplateHtml(templateBody) {
  return textToHtml(typeof templateBody === 'string' ? templateBody : '');
}
