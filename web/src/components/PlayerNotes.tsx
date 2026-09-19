import { useState, type SubmitEvent } from 'react';
import { api, describeError } from '../api/client';
import type { Note } from '../api/types';
import { hasRole, useCurrentUser } from '../auth/context';
import { useApi } from '../hooks/useApi';
import { formatDateTime, t } from '../i18n';

const MAX_LENGTH = 5000;

function NoteForm({
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    onSubmit(body).then(
      () => {
        setBusy(false);
        setBody('');
      },
      (e: unknown) => {
        setBusy(false);
        setError(describeError(e));
      },
    );
  };

  return (
    <form className="note-form" onSubmit={submit}>
      <label className="field">
        <span>{initial ? t('notes.edit') : t('notes.new')}</span>
        <textarea
          value={body}
          rows={3}
          maxLength={MAX_LENGTH}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
      </label>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          type="submit"
          className="button button--primary button--small"
          disabled={busy || body.trim() === ''}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="button button--small" onClick={onCancel}>
            {t('notes.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

function History({ note }: { note: Note }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="note__history"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>{t('notes.history', { count: note.revisions })}</summary>
      {open && <Revisions noteId={note.id} />}
    </details>
  );
}

function Revisions({ noteId }: { noteId: number }) {
  const { data, error } = useApi((signal) => api.noteRevisions(noteId, signal), [noteId]);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted small">{t('common.loading')}</p>;
  return (
    <ol className="note__revisions">
      {data.revisions.map((r) => (
        <li key={`${String(r.replacedAt)}-${r.body}`}>
          <p className="muted small">
            {t('notes.replaced', { time: formatDateTime(r.replacedAt), editor: r.editorName })}
          </p>
          <p className="note__body">{r.body}</p>
        </li>
      ))}
    </ol>
  );
}

function NoteItem({ note, onChanged }: { note: Note; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  const remove = () => {
    if (!window.confirm(t('notes.deleteConfirm'))) return;
    api.deleteNote(note.id).then(onChanged, (e: unknown) => {
      setError(describeError(e));
    });
  };

  return (
    <li className="note">
      <p className="muted small">
        {t('notes.meta', { author: note.authorName, time: formatDateTime(note.createdAt) })}
        {note.updatedAt !== note.createdAt && (
          <> · {t('notes.edited', { time: formatDateTime(note.updatedAt) })}</>
        )}
      </p>
      {editing ? (
        <NoteForm
          initial={note.body}
          submitLabel={t('notes.save')}
          onSubmit={async (body) => {
            await api.updateNote(note.id, body);
            setEditing(false);
            onChanged();
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <p className="note__body">{note.body}</p>
      )}
      {error && <p className="alert">{error}</p>}
      <div className="note__footer">
        {note.revisions > 0 && <History note={note} />}
        {note.editable && !editing && (
          <div className="button-row">
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('notes.edit')}
            </button>
            <button type="button" className="button button--small" onClick={remove}>
              {t('notes.delete')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Internal notes about a player; moderators and admins can write them. */
export function PlayerNotes({ userId }: { userId: number }) {
  const user = useCurrentUser();
  const [version, setVersion] = useState(0);
  const { data, error } = useApi((signal) => api.notes(userId, signal), [userId, version]);
  const reload = () => {
    setVersion((v) => v + 1);
  };

  return (
    <>
      <p className="muted small">{t('notes.hint')}</p>
      {error && <p className="alert">{error}</p>}
      {data && data.notes.length === 0 && <p className="muted">{t('notes.empty')}</p>}
      {data && data.notes.length > 0 && (
        <ul className="notes">
          {data.notes.map((note) => (
            <NoteItem key={note.id} note={note} onChanged={reload} />
          ))}
        </ul>
      )}
      {hasRole(user, 'moderator') && (
        <NoteForm
          submitLabel={t('notes.add')}
          onSubmit={async (body) => {
            await api.addNote(userId, body);
            reload();
          }}
        />
      )}
    </>
  );
}
