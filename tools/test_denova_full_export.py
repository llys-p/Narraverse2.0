import unittest

from denova_full_export import valid_translation_field_path


class MasterTranslationFieldPathTest(unittest.TestCase):
    def test_accepts_stable_nested_entry_paths_without_accepting_traversal(self):
        self.assertTrue(valid_translation_field_path("character.name"))
        self.assertTrue(valid_translation_field_path("lorebook.entries/entry-abc123/content"))
        self.assertTrue(valid_translation_field_path("character_book.entries/entry-abc123/secondary_keys"))
        self.assertFalse(valid_translation_field_path("lorebook.entries/../content"))
        self.assertFalse(valid_translation_field_path("lorebook.entries/entry-abc123/runtime_script"))


if __name__ == "__main__":
    unittest.main()
