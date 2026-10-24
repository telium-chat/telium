-- Two colours a person picks for their profile card: the top and the bottom
-- of its border, and the hues its ground is tinted with. Separate from
-- `accent_color`, which is the banner's, because a card themed like Discord's
-- has three colours in it and the banner is only one of them.
--
-- One column holding the JSON pair `[top, bottom]` rather than two, because a
-- gradient needs both ends or neither, and because the column is named what
-- the wire calls it -- which is how the migration conformance suite knows an
-- account move carries it.
ALTER TABLE profiles ADD COLUMN theme_colors TEXT;
