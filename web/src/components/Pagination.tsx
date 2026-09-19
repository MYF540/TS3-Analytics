import { t } from '../i18n';

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}

export function Pagination({ page, pageSize, total, onChange }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label={t('pagination.label')}>
      <button
        type="button"
        className="button"
        disabled={page <= 1}
        onClick={() => {
          onChange(page - 1);
        }}
      >
        {t('pagination.previous')}
      </button>
      <span className="muted">{t('pagination.status', { page, pages })}</span>
      <button
        type="button"
        className="button"
        disabled={page >= pages}
        onClick={() => {
          onChange(page + 1);
        }}
      >
        {t('pagination.next')}
      </button>
    </nav>
  );
}
