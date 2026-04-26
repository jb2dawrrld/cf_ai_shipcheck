export default {
  async fetch(): Promise<Response> {
    return new Response("hello from demo fixture");
  },
} satisfies ExportedHandler<Env>;
