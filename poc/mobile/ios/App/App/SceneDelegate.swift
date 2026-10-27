import UIKit
import Capacitor

// Keep one bridge and one storage origin for this single-window PoC.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let sceneWindow = scene as? UIWindowScene else { return }
        let appWindow = UIWindow(windowScene: sceneWindow)
        appWindow.rootViewController = CAPBridgeViewController()
        window = appWindow
        appWindow.makeKeyAndVisible()
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: contexts)
    }

    func scene(_ scene: UIScene, continue activity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: activity)
    }
}
