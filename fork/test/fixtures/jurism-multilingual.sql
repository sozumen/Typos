-- 4

-- This code is used only when migrating to MLZ from an existing
-- Zotero DB, or when creating an MLZ DB from scratch. In the former
-- case the version number ("multilingual") will be bumped down to "1"
-- during install to indicate that hack-field records should be handled.

-- XXX The "parent" record is no longer used
CREATE TABLE zlsTags (
	tag TEXT PRIMARY KEY,
	nickname TEXT,
	parent TEXT
);
CREATE INDEX zlsTags_nickname ON zlsTags(nickname);
CREATE INDEX zlsTags_parent ON zlsTags(parent);

CREATE TABLE zlsPreferences (
	profile TEXT NOT NULL,
	param TEXT NOT NULL,
	tag TEXT NOT NULL,
	PRIMARY KEY (profile, param, tag)
);
CREATE INDEX zlsPreferences_param ON zlsPreferences(param, profile);

CREATE TABLE itemCreatorsMain (
	itemID INT,
	creatorID INT,
	creatorTypeID INT DEFAULT 1,
	orderIndex INT DEFAULT 0,
	languageTag TEXT,
	PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex),
	FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
	FOREIGN KEY (creatorID) REFERENCES creators(creatorID) ON DELETE CASCADE
);
CREATE INDEX itemCreatorsMain_creatorTypeID ON itemCreatorsMain(creatorTypeID);
CREATE INDEX itemCreatorsMain_itemID_orderIndex ON itemCreatorsMain(itemID, orderIndex);

CREATE TABLE itemCreatorsAlt (
	itemID INT,
	creatorID INT,
	creatorTypeID INT DEFAULT 1,
	orderIndex INT DEFAULT 0,
	languageTag TEXT,
	PRIMARY KEY (itemID, creatorTypeID, orderIndex, languageTag),
	FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
	FOREIGN KEY (creatorID) REFERENCES creators(creatorID) ON DELETE CASCADE,
	FOREIGN KEY (creatorTypeID) REFERENCES creatorTypes(creatorTypeID)
);
CREATE INDEX itemCreatorsAlt_creatorTypeID ON itemCreatorsAlt(creatorTypeID);
CREATE INDEX itemCreatorsAlt_itemID_orderIndex ON itemCreatorsAlt(itemID, orderIndex);

CREATE TABLE itemDataMain (
	itemID INTEGER,
	fieldID INTEGER,
	languageTag TEXT,
	PRIMARY KEY (itemID, fieldID),
	FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
	FOREIGN KEY (fieldID) REFERENCES fields(fieldID)
);
CREATE INDEX itemDataMain_fieldID ON itemDataMain(fieldID);

CREATE TABLE itemDataAlt (
	itemID INTEGER,
	fieldID INTEGER,
	languageTag TEXT,
	valueID INTEGER,
	PRIMARY KEY (itemID, fieldID, languageTag),
	FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
	FOREIGN KEY (fieldID) REFERENCES fields(fieldID),
	FOREIGN KEY (valueID) REFERENCES itemDataValues(valueID)
);
CREATE INDEX itemDataAlt_fieldID ON itemDataAlt(fieldID);
CREATE INDEX itemDataAlt_itemID_fieldID ON itemDataAlt(itemID, fieldID);

