import type { NetworkRange, TimeRange } from '../api/types';
import { t } from '../i18n';

interface Props<R extends TimeRange | NetworkRange> {
  value: R;
  options: readonly R[];
  onChange: (range: R) => void;
  label?: string;
}

/** Segmented control for time ranges (one row above the charts it controls). */
export function RangePicker<R extends TimeRange | NetworkRange>({
  value,
  options,
  onChange,
  label,
}: Props<R>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label ?? t('common.range')}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          className={option === value ? 'segmented__item is-active' : 'segmented__item'}
          onClick={() => {
            onChange(option);
          }}
        >
          {t(`range.${option}`)}
        </button>
      ))}
    </div>
  );
}
