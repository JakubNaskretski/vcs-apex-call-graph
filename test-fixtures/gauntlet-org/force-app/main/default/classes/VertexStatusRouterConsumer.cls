public class VertexStatusRouterConsumer {
  public void run(String code1, String code2) {
    VertexStatusRouter router = new VertexStatusRouter();
    router.route(code1);   // site 1 -> VertexStatusRouter.route [via=typed] [MUST]
    router.route(code2);   // site 2 -> VertexStatusRouter.route [via=typed] [MUST] — bonus MULTI-SITE demo: 1 caller node, 2 site rows
  }
}
