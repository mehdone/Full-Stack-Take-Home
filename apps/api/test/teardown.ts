/**
 * Jest global teardown: Clean up after tests.
 *
 * We use the docker-compose Postgres, so nothing to tear down here.
 */

async function teardown(): Promise<void> {
  console.log("[Jest global teardown] Tests complete");
}

export default teardown;
