-- Where an upload went when its owner's account moved.
--
-- Set on the old origin, after the destination has acknowledged the bundle
-- that carried the bytes, and only on the rows the bundle carried. A fetch for
-- such an object is answered with a redirect to the new origin for as long as
-- this server is up; a row still NULL is served from here as before.
ALTER TABLE media ADD COLUMN moved_to TEXT;
