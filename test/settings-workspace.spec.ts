type SettingsSection = { id: string; name: string; detail: string; admin: boolean };
const { settingsPanelGroups, settingsSectionFromUrl, settingsSections } = require('../public/settings.js') as {
  settingsPanelGroups: Record<string, string>;
  settingsSectionFromUrl: (search: string, role: string) => string;
  settingsSections: SettingsSection[];
};

describe('grouped settings workspace', () => {
  it('supports deep links for administrators and returns safe defaults for restricted sections', () => {
    expect(settingsSectionFromUrl('?section=cache', 'admin')).toBe('cache');
    expect(settingsSectionFromUrl('?section=access', 'admin')).toBe('access');
    expect(settingsSectionFromUrl('?section=cache', 'operator')).toBe('general');
    expect(settingsSectionFromUrl('?section=not-a-section', 'admin')).toBe('general');
    expect(settingsSectionFromUrl('', 'viewer')).toBe('general');
  });

  it('places all existing and dynamic settings panels into one of seven focused groups', () => {
    expect(settingsSections.map(section => section.id)).toEqual(['general', 'notifications', 'execution', 'cache', 'maintenance', 'access', 'audit']);
    expect(new Set(Object.values(settingsPanelGroups))).toEqual(new Set(settingsSections.map(section => section.id)));
    expect(settingsPanelGroups['notification-panel']).toBe('notifications');
    expect(settingsPanelGroups['source-groups-panel']).toBe('execution');
    expect(settingsPanelGroups['cache-settings-panel']).toBe('cache');
    expect(settingsPanelGroups['audit-panel']).toBe('audit');
  });
});
