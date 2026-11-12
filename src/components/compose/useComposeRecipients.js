import { addRecipients, removeRecipientToken } from '../../shared/recipientTokens';

export function useComposeRecipients({ detaching, formData, editRevision, setFormData, setError }) {
  // A recipient chip field hands over its whole comma-joined string.
  const setRecipients = (field) => (value) => {
    // WebKit blurs the focused field when sending makes the editor inert.
    // Committing its unchanged draft is not a new mail generation.
    if (detaching || value === formData[field]) return;
    editRevision.current[field]++;
    setFormData(prev => ({ ...prev, [field]: value }));
    setError(null);
  };

  // A pasted mailto: link's ?cc= / ?bcc= land in those fields.
  const routeRecipients = (field, text) => {
    if (detaching) return;
    editRevision.current[field]++;
    setFormData(prev => ({ ...prev, [field]: addRecipients(prev[field] || '', text) }));
    setError(null);
  };

  // A chip dragged from one recipient field to another.
  const moveRecipient = (from, to, token) => {
    if (detaching) return;
    editRevision.current[from]++; editRevision.current[to]++;
    setFormData(prev => ({
      ...prev,
      [from]: removeRecipientToken(prev[from] || '', token),
      [to]: addRecipients(prev[to] || '', token),
    }));
    setError(null);
  };

  const handleChange = (e) => {
    if (detaching) return;
    const { name, value } = e.target;
    if (name in editRevision.current) editRevision.current[name]++;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(null);
  };

  return { setRecipients, routeRecipients, moveRecipient, handleChange };
}
