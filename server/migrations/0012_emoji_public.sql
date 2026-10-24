-- Media referenced by guild emoji must be public: expression assets are public
-- by construction, but before the fix in store_expression_asset a re-upload of
-- bytes already stored under another purpose left the media row capability-gated,
-- so fetching such an emoji 404'd. Promote rows already claimed by an emoji.
UPDATE media SET purpose = 'expression'
WHERE hash IN (SELECT DISTINCT media_hash FROM emojis);