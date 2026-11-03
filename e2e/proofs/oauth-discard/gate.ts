import assert from "node:assert/strict";
import { createServer } from "node:http";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

/** Native background work is counted so missing revocation fails an assertion without polling. */
export async function discardGate() {
  let entered = deferred<string>();
  let released = deferred<void>();
  let drained = deferred<void>();
  const jobs = new Set<string>();
  let armed = false;
  let account: string | undefined;
  let open = false;
  const finish = () => {
    if (open && account !== undefined && jobs.size === 0) drained.resolve();
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const id = url.searchParams.get("id");
      if (url.pathname === "/work/start") {
        assert.ok(id);
        assert.ok(!jobs.has(id));
        jobs.add(id);
      } else if (url.pathname === "/work/end") {
        assert.ok(id);
        jobs.delete(id);
        finish();
      } else if (url.pathname === "/resolve/end") {
        assert.ok(id);
        jobs.delete(`resolve/${id}`);
        finish();
      } else if (url.pathname === "/arm") {
        assert.ok(!armed || open);
        entered = deferred<string>();
        released = deferred<void>();
        drained = deferred<void>();
        account = undefined;
        open = false;
        armed = true;
      } else if (url.pathname === "/arrive") {
        if (armed && account === undefined) {
          assert.ok(typeof id === "string" && id.startsWith("acc_"));
          const resolve = url.searchParams.get("resolve");
          assert.ok(resolve);
          jobs.add(`resolve/${resolve}`);
          account = id;
          entered.resolve(id);
          await released.promise;
        }
      } else if (url.pathname === "/entered") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ account: await entered.promise }));
        return;
      } else if (url.pathname === "/release") {
        open = true;
        released.resolve();
        finish();
      } else if (url.pathname === "/drained") {
        await drained.promise;
      } else throw new Error("Unknown proof command");
      response.writeHead(204).end();
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      released.resolve();
      drained.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
