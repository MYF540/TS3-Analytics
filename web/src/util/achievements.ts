import type { AchievementDefinition, AchievementUnit } from '../api/types';
import { formatNumber, t, type MessageKey } from '../i18n';

/** A value in the unit of an achievement: "100 h", "30 Tage", "5 Jahre", "25". */
export function formatAchievementValue(unit: AchievementUnit, value: number): string {
  switch (unit) {
    case 'seconds':
      return t('unit.hours', { value: formatNumber(Math.floor(value / 3600)) });
    case 'days':
      return t(value === 1 ? 'unit.day' : 'unit.days', { value: formatNumber(value) });
    case 'years':
      return t(value === 1 ? 'unit.year' : 'unit.years', { value: formatNumber(value) });
    case 'count':
      return formatNumber(value);
  }
}

/** Metal of a tier ("Gold"); empty for achievements with a single tier. */
export function tierName(achievement: Pick<AchievementDefinition, 'tiers'>, tier: number): string {
  if (achievement.tiers.length <= 1 || tier < 1 || tier > 5) return '';
  return t(`achievement.tier.${String(tier)}` as MessageKey);
}

/** "Stufen: 10 h · 100 h · …", or empty for yes/no achievements. */
export function thresholdList(achievement: AchievementDefinition): string {
  const yesNo = achievement.tiers.length === 1 && achievement.tiers[0] === 1;
  if (yesNo) return '';
  return t('achievements.thresholds', {
    list: achievement.tiers.map((v) => formatAchievementValue(achievement.unit, v)).join(' · '),
  });
}

/** CSS modifier for the badge color of a tier. */
export function tierClass(achievement: Pick<AchievementDefinition, 'tiers'>, tier: number): string {
  if (achievement.tiers.length <= 1) return 'achievement--single';
  return `achievement--tier-${String(Math.min(Math.max(tier, 1), 5))}`;
}
