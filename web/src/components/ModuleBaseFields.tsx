import { t } from '../i18n';

export interface ModuleBaseDraft {
  enabled: boolean;
  dryRun: boolean;
  exemptGroupIds: number[];
}

interface Props {
  value: ModuleBaseDraft;
  /** Server groups seen on the server. */
  groups: readonly { id: number; name: string }[];
  onChange: (changes: Partial<ModuleBaseDraft>) => void;
}

/** What every bot module can be told: on/off, test mode and which groups to leave alone. */
export function ModuleBaseFields({ value, groups, onChange }: Props) {
  // Groups that were saved but are not known (any more) must stay visible and removable.
  const unknown = value.exemptGroupIds.filter((id) => !groups.some((group) => group.id === id));
  const all = [
    ...groups,
    ...unknown.map((id) => ({ id, name: t('automation.unknownGroup', { id }) })),
  ];

  const toggle = (id: number) => {
    const next = value.exemptGroupIds.includes(id)
      ? value.exemptGroupIds.filter((group) => group !== id)
      : [...value.exemptGroupIds, id];
    onChange({ exemptGroupIds: next });
  };

  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => {
            onChange({ enabled: event.target.checked });
          }}
        />
        {t('automation.enabled')}
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.dryRun}
          onChange={(event) => {
            onChange({ dryRun: event.target.checked });
          }}
        />
        {t('automation.dryRun')}
      </label>
      <p className="muted small">{t('automation.dryRunHint')}</p>
      {value.enabled && !value.dryRun && (
        <p className="notice notice--warn" role="status">
          {t('automation.liveWarning')}
        </p>
      )}

      <fieldset className="settings-form__channels">
        <legend>
          {t('automation.exempt')}{' '}
          <span className="muted small">
            {t('settings.network.selected', { count: value.exemptGroupIds.length })}
          </span>
        </legend>
        <p className="muted small">{t('automation.exemptHint')}</p>
        {all.length === 0 ? (
          <p className="muted">{t('automation.noGroups')}</p>
        ) : (
          <ul className="channel-list">
            {all.map((group) => (
              <li key={group.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={value.exemptGroupIds.includes(group.id)}
                    onChange={() => {
                      toggle(group.id);
                    }}
                  />
                  {group.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </>
  );
}
