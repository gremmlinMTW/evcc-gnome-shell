import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function parseSetting(settings, key, fallback) {
    try {
        return JSON.parse(settings.get_string(key) || JSON.stringify(fallback));
    } catch (e) {
        return fallback;
    }
}

function flattenValues(value, prefix = '', result = []) {
    if (value === null || value === undefined)
        return result;

    if (Array.isArray(value)) {
        value.forEach((item, index) => flattenValues(item, `${prefix}[${index}]`, result));
    } else if (typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => {
            flattenValues(item, prefix ? `${prefix}.${key}` : key, result);
        });
    } else if (prefix) {
        result.push({ id: prefix, name: prefix.replaceAll('.', ' / ') });
    }

    return result;
}

function addAuthorization(message, user, password) {
    if (user || password) {
        const bytes = new TextEncoder().encode(`${user}:${password}`);
        message.request_headers.append('Authorization', `Basic ${GLib.base64_encode(bytes)}`);
    }
}

export default class EvccPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const connectionGroup = new Adw.PreferencesGroup({ title: 'evcc connection' });
        page.add(connectionGroup);

        const urlRow = new Adw.EntryRow({
            title: 'evcc URL',
            text: settings.get_string('evcc-url'),
        });
        urlRow.connect('changed', () => {
            settings.set_string('evcc-url', urlRow.get_text().replace(/\/$/, ''));
        });
        connectionGroup.add(urlRow);

        const userRow = new Adw.EntryRow({
            title: 'Username',
            text: settings.get_string('evcc-user'),
        });
        userRow.connect('changed', () => settings.set_string('evcc-user', userRow.get_text()));
        connectionGroup.add(userRow);

        const passwordRow = new Adw.PasswordEntryRow({ title: 'Password' });
        passwordRow.set_text(settings.get_string('evcc-password'));
        passwordRow.connect('changed', () => settings.set_string('evcc-password', passwordRow.get_text()));
        connectionGroup.add(passwordRow);

        const statusRow = new Adw.ActionRow({ title: 'Connection' });
        const connectButton = new Gtk.Button({ label: 'Connect', valign: Gtk.Align.CENTER });
        statusRow.add_suffix(connectButton);
        connectionGroup.add(statusRow);

        const valuesGroup = new Adw.PreferencesGroup({ title: 'Values shown in the top bar' });
        page.add(valuesGroup);
        const valuesBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        valuesGroup.add(valuesBox);

        const renderValues = () => {
            let child = valuesBox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                valuesBox.remove(child);
                child = next;
            }

            const available = parseSetting(settings, 'evcc-available-values', []);
            const selected = new Set(parseSetting(settings, 'evcc-selected-values', []));
            if (available.length === 0) {
                valuesBox.append(new Gtk.Label({
                    label: 'Connect to evcc to discover available values.',
                    xalign: 0,
                    margin_top: 6,
                    margin_bottom: 6,
                }));
                return;
            }

            available.forEach(item => {
                const check = new Gtk.CheckButton({ label: item.name, active: selected.has(item.id) });
                check.connect('toggled', () => {
                    const selection = new Set(parseSetting(settings, 'evcc-selected-values', []));
                    if (check.get_active())
                        selection.add(item.id);
                    else
                        selection.delete(item.id);
                    settings.set_string('evcc-selected-values', JSON.stringify([...selection]));
                });
                valuesBox.append(check);
            });
        };

        const session = new Soup.Session();
        connectButton.connect('clicked', () => {
            connectButton.set_sensitive(false);
            connectButton.set_label('Connecting...');
            const url = settings.get_string('evcc-url').replace(/\/$/, '');
            try {
                const message = new Soup.Message({
                    method: 'GET',
                    uri: GLib.Uri.parse(`${url}/api/state`, GLib.UriFlags.NONE),
                });
                addAuthorization(message, settings.get_string('evcc-user'), settings.get_string('evcc-password'));
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (httpSession, result) => {
                    try {
                        const bytes = httpSession.send_and_read_finish(result);
                        if (message.status_code !== 200)
                            throw new Error(`evcc returned HTTP ${message.status_code}`);

                        const response = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
                        const values = flattenValues(response.result ?? response)
                            .map(({ id, name }) => ({ id, name: name.replaceAll('.', ' / ') }));
                        values.sort((left, right) => left.name.localeCompare(right.name));
                        settings.set_string('evcc-available-values', JSON.stringify(values));

                        const validIds = new Set(values.map(item => item.id));
                        const selected = parseSetting(settings, 'evcc-selected-values', [])
                            .filter(id => validIds.has(id));
                        settings.set_string('evcc-selected-values', JSON.stringify(selected));
                        statusRow.set_subtitle(`Connected; found ${values.length} values`);
                        connectButton.set_label('Refresh values');
                        renderValues();
                    } catch (e) {
                        statusRow.set_subtitle(e.message);
                        connectButton.set_label('Retry');
                    }
                    connectButton.set_sensitive(true);
                });
            } catch (e) {
                statusRow.set_subtitle(e.message);
                connectButton.set_label('Retry');
                connectButton.set_sensitive(true);
            }
        });

        const cachedValues = parseSetting(settings, 'evcc-available-values', []);
        if (cachedValues.length > 0)
            statusRow.set_subtitle(`${cachedValues.length} cached values; connect to refresh`);
        renderValues();
    }
}
