import { t } from '../i18n';

export interface EnglishField {
  /** Stable key, also used for React. */
  id: string;
  /** Already translated, so a section can say which part of the module a text belongs to. */
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
}

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  fields: readonly EnglishField[];
  /** What else applies to this module's English texts, e.g. answer words understood in both. */
  note?: string | undefined;
}

/**
 * The English counterpart of a module's player texts (T12.1): a switch, off by default, and
 * one field per text. Which language a player gets is decided by their country, as for the
 * rule confirmation.
 */
export function EnglishTexts({ enabled, onToggle, fields, note }: Props) {
  return (
    <fieldset className="settings-form__channels" aria-label={t('english.title')}>
      <legend>{t('english.title')}</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            onToggle(event.target.checked);
          }}
        />
        {t('english.enabled')}
      </label>
      <p className="muted small">{t('english.hint')}</p>
      {note && <p className="muted small">{note}</p>}
      {enabled &&
        fields.map((field) => (
          <label className="field" key={field.id}>
            <span>{field.label}</span>
            <input
              type="text"
              lang="en"
              maxLength={field.max}
              value={field.value}
              aria-invalid={field.value.trim() === ''}
              onChange={(event) => {
                field.onChange(event.target.value);
              }}
            />
          </label>
        ))}
    </fieldset>
  );
}
