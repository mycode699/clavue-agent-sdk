/**
 * Test fixture — worker_thread entry that exits without ever posting a
 * completion or error message. Exercises the parent's "worker died early"
 * detection path.
 */
process.exit(0)
