import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { Tag, TagColor, TagWithUsage } from '../api/types';
import { hasRole, useCurrentUser } from '../auth/context';
import { useApi } from '../hooks/useApi';
import { t } from '../i18n';

const TAG_COLORS: readonly TagColor[] = ['blue', 'orange', 'green', 'red', 'purple', 'gray'];

export function TagChip({ tag }: { tag: Tag }) {
  return <span className={`tag tag--${tag.color}`}>{tag.name}</span>;
}

interface EditorProps {
  userId: number;
  current: Tag[];
  onSaved: (tags: Tag[]) => void;
  onCancel: () => void;
}

function TagEditor({ userId, current, onSaved, onCancel }: EditorProps) {
  const user = useCurrentUser();
  const loaded = useApi((signal) => api.tags(signal), []);
  const [created, setCreated] = useState<TagWithUsage[]>([]);
  const [deleted, setDeleted] = useState<ReadonlySet<number>>(new Set());
  const all = loaded.data
    ? [...loaded.data.tags, ...created].filter((tag) => !deleted.has(tag.id))
    : undefined;
  const [selected, setSelected] = useState(() => new Set(current.map((tag) => tag.id)));
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('blue');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const shownError = error ?? loaded.error;

  const toggle = (id: number) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const create = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(async () => {
      const tag = await api.createTag(name, color);
      setCreated((list) => [...list, { ...tag, users: 0 }]);
      setSelected((s) => new Set(s).add(tag.id));
      setName('');
    });
  };

  const remove = (tag: TagWithUsage) => {
    if (!window.confirm(t('tags.deleteConfirm', { name: tag.name }))) return;
    void run(async () => {
      await api.deleteTag(tag.id);
      setDeleted((d) => new Set(d).add(tag.id));
      setSelected((s) => {
        const next = new Set(s);
        next.delete(tag.id);
        return next;
      });
    });
  };

  const save = () => {
    void run(async () => {
      const res = await api.setUserTags(userId, [...selected]);
      onSaved(res.tags);
    });
  };

  return (
    <div className="tag-editor card">
      {shownError && (
        <p className="alert" role="alert">
          {shownError}
        </p>
      )}
      {all === undefined ? (
        !shownError && <p className="muted">{t('common.loading')}</p>
      ) : (
        <ul className="tag-editor__list">
          {all.map((tag) => (
            <li key={tag.id}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.has(tag.id)}
                  onChange={() => {
                    toggle(tag.id);
                  }}
                />
                <TagChip tag={tag} />
                <span className="muted small">{t('tags.usage', { count: tag.users })}</span>
              </label>
              {hasRole(user, 'admin') && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('tags.delete', { name: tag.name })}
                  title={t('tags.delete', { name: tag.name })}
                  disabled={busy}
                  onClick={() => {
                    remove(tag);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="tag-editor__new" onSubmit={create}>
        <label className="field">
          <span>{t('tags.new')}</span>
          <input
            value={name}
            maxLength={32}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>{t('tags.color')}</span>
          <select
            value={color}
            onChange={(event) => {
              setColor(event.target.value as TagColor);
            }}
          >
            {TAG_COLORS.map((c) => (
              <option key={c} value={c}>
                {t(`tags.color.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button" disabled={busy || name.trim() === ''}>
          {t('tags.create')}
        </button>
      </form>
      <div className="button-row">
        <button type="button" className="button button--primary" disabled={busy} onClick={save}>
          {t('tags.save')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t('tags.cancel')}
        </button>
      </div>
    </div>
  );
}

/** Tags of a player; moderators and admins can change them. */
export function PlayerTags({ userId, tags }: { userId: number; tags: Tag[] }) {
  const user = useCurrentUser();
  const [saved, setSaved] = useState<Tag[]>();
  const [editing, setEditing] = useState(false);
  const current = saved ?? tags;

  return (
    <div className="player-tags">
      <ul className="tag-list" aria-label={t('tags.label')}>
        {current.length === 0 && <li className="muted small">{t('tags.none')}</li>}
        {current.map((tag) => (
          <li key={tag.id}>
            <TagChip tag={tag} />
          </li>
        ))}
        {hasRole(user, 'moderator') && !editing && (
          <li>
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('tags.edit')}
            </button>
          </li>
        )}
      </ul>
      {editing && (
        <TagEditor
          userId={userId}
          current={current}
          onSaved={(next) => {
            setSaved(next);
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
