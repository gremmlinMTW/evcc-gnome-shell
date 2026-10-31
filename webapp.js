import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';

const stdin = Gio.File.new_for_path('/dev/stdin').read(null);
const [line] = new Gio.DataInputStream({ base_stream: stdin }).read_line(null);
const config = JSON.parse(new TextDecoder('utf-8').decode(line));

const application = new Gtk.Application({
    application_id: 'org.gnome.shell.extensions.evcctopbar.webapp',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

application.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application,
        title: config.windowTitle,
        default_width: 420,
        default_height: 820,
    });
    window.set_decorated(false);

    const view = new WebKit.WebView();
    if (config.user || config.password) {
        view.connect('authenticate', (webView, request) => {
            const credential = WebKit.Credential.new(
                config.user,
                config.password,
                WebKit.CredentialPersistence.NONE
            );
            request.authenticate(credential);
            return true;
        });
    }
    window.set_child(view);
    view.load_uri(config.url);
    window.present();
});

application.run([]);